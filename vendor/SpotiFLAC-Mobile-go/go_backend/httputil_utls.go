//go:build !ios

package gobackend

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// utlsSessionCache is shared by every uTLS handshake so TLS 1.3 tickets enable
// resumption (fewer round-trips) across requests and hosts.
var utlsSessionCache = utls.NewLRUClientSessionCache(0)

// utlsTransport dials with a Chrome TLS fingerprint and pools one healthy HTTP/2
// connection per host, re-dialing when it dies (e.g. after a network switch).
type utlsTransport struct {
	dialer *net.Dialer
	h2     *http2.Transport
	mu     sync.Mutex
	conns  map[string]*http2.ClientConn
}

func newUTLSTransport() *utlsTransport {
	return &utlsTransport{
		dialer: &net.Dialer{
			Timeout:   10 * Second,
			KeepAlive: 30 * Second,
		},
		h2:    &http2.Transport{},
		conns: make(map[string]*http2.ClientConn),
	}
}

func (t *utlsTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		return sharedTransport.RoundTrip(req)
	}

	host := req.URL.Hostname()
	addr := net.JoinHostPort(host, t.getPort(req.URL))

	if cc := t.cachedConn(addr); cc != nil {
		resp, err := cc.RoundTrip(req)
		if err == nil {
			return resp, nil
		}
		// A pooled conn can be silently dead after a network switch. Drop it
		// and, when the request is safely repeatable, fall through to a fresh
		// dial instead of failing where the old dial-per-request code would
		// have succeeded.
		t.invalidate(addr, cc)
		retryReq, ok := rewindRequestBody(req)
		if !ok {
			return nil, err
		}
		req = retryReq
	}

	tlsConn, proto, err := t.dial(req.Context(), host, addr)
	if err != nil {
		return nil, err
	}

	if proto != "h2" {
		// HTTP/1.1: single-use conn closed once the body is drained.
		transport := &http.Transport{
			DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return tlsConn, nil
			},
			DisableKeepAlives: true,
		}
		return transport.RoundTrip(req)
	}

	cc, err := t.h2.NewClientConn(tlsConn)
	if err != nil {
		tlsConn.Close()
		return nil, err
	}
	cc = t.storeConn(addr, cc)
	return cc.RoundTrip(req)
}

// rewindRequestBody returns a request whose body can be sent again after a
// failed attempt on a pooled connection: bodyless requests as-is, requests
// with GetBody with a rebuilt body, anything else not ok.
func rewindRequestBody(req *http.Request) (*http.Request, bool) {
	if req.Body == nil {
		return req, true
	}
	if req.GetBody == nil {
		return nil, false
	}
	body, err := req.GetBody()
	if err != nil {
		return nil, false
	}
	retryReq := req.Clone(req.Context())
	retryReq.Body = body
	return retryReq, true
}

// dial opens a TCP connection and completes the Chrome-fingerprint TLS handshake,
// returning the connection and negotiated ALPN protocol.
func (t *utlsTransport) dial(ctx context.Context, host, addr string) (*utls.UConn, string, error) {
	conn, err := dialWithDoHFallback(ctx, t.dialer, "tcp", addr)
	if err != nil {
		return nil, "", err
	}

	opts := GetNetworkCompatibilityOptions()
	tlsConn := utls.UClient(conn, &utls.Config{
		RootCAs:            supplementalRootCAs(),
		InsecureSkipVerify: opts.InsecureTLS,
		ServerName:         host,
		NextProtos:         []string{"h2", "http/1.1"},
		ClientSessionCache: utlsSessionCache,
	}, utls.HelloChrome_Auto)

	if err := tlsConn.Handshake(); err != nil {
		conn.Close()
		return nil, "", err
	}
	return tlsConn, tlsConn.ConnectionState().NegotiatedProtocol, nil
}

func (t *utlsTransport) cachedConn(addr string) *http2.ClientConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	if cc := t.conns[addr]; cc != nil && cc.CanTakeNewRequest() {
		return cc
	}
	return nil
}

func (t *utlsTransport) invalidate(addr string, cc *http2.ClientConn) {
	t.mu.Lock()
	if t.conns[addr] == cc {
		delete(t.conns, addr)
	}
	t.mu.Unlock()
}

// storeConn caches cc, but if a concurrent dial already cached a healthy conn for
// addr it discards the freshly built cc (no in-flight requests) and returns the
// existing one, avoiding a leaked connection.
func (t *utlsTransport) storeConn(addr string, cc *http2.ClientConn) *http2.ClientConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	if existing := t.conns[addr]; existing != nil && existing.CanTakeNewRequest() {
		cc.Close()
		return existing
	}
	t.conns[addr] = cc
	return cc
}

// closeIdleConnections drops every pooled conn so the next request re-dials —
// needed after a network switch, where pooled conns are silently dead and the
// first request would otherwise hang on one until its timeout. Conns are shut
// down gracefully so in-flight streams finish (or fail) before the close.
func (t *utlsTransport) closeIdleConnections() {
	t.mu.Lock()
	conns := t.conns
	t.conns = make(map[string]*http2.ClientConn)
	t.mu.Unlock()
	for _, cc := range conns {
		go cc.Shutdown(context.Background())
	}
}

// closeUTLSIdleConnections lets platform-neutral code (CloseIdleConnections)
// reach the uTLS pool; the ios build provides a no-op stub.
func closeUTLSIdleConnections() {
	cloudflareBypassTransport.closeIdleConnections()
}

func (t *utlsTransport) getPort(u *url.URL) string {
	if u.Port() != "" {
		return u.Port()
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

var cloudflareBypassTransport = newUTLSTransport()

var cloudflareBypassClient = &http.Client{
	Transport: cloudflareBypassTransport,
	Timeout:   DefaultTimeout,
}

func GetCloudflareBypassClient() *http.Client {
	return cloudflareBypassClient
}

func DoRequestWithCloudflareBypass(req *http.Request) (*http.Response, error) {
	req.Header.Set("User-Agent", userAgentForURL(req.URL))

	resp, err := sharedClient.Do(req)
	if err == nil {
		if resp.StatusCode == 403 || resp.StatusCode == 503 {
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()

			if readErr == nil {
				bodyStr := strings.ToLower(string(body))
				cloudflareMarkers := []string{
					"cloudflare", "cf-ray", "checking your browser",
					"please wait", "ddos protection", "ray id",
					"enable javascript", "challenge-platform",
				}

				isCloudflare := false
				for _, marker := range cloudflareMarkers {
					if strings.Contains(bodyStr, marker) {
						isCloudflare = true
						break
					}
				}

				if isCloudflare {
					LogDebug("HTTP", "Cloudflare detected, retrying with Chrome TLS fingerprint...")

					reqCopy := req.Clone(req.Context())
					reqCopy.Header.Set("User-Agent", userAgentForURL(reqCopy.URL))

					return cloudflareBypassClient.Do(reqCopy)
				}
			}

			return &http.Response{
				Status:     resp.Status,
				StatusCode: resp.StatusCode,
				Header:     resp.Header,
				Body:       io.NopCloser(strings.NewReader(string(body))),
			}, nil
		}
		return resp, nil
	}

	if isTLSHandshakeOrResetError(err) {
		LogDebug("HTTP", "TLS error detected, retrying with Chrome TLS fingerprint: %v", err)

		reqCopy := req.Clone(req.Context())
		reqCopy.Header.Set("User-Agent", userAgentForURL(reqCopy.URL))

		return cloudflareBypassClient.Do(reqCopy)
	}

	CheckAndLogISPBlocking(err, req.URL.String(), "HTTP")
	return nil, err
}
