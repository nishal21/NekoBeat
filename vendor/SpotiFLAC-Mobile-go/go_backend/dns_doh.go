package gobackend

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// DNS-over-HTTPS fallback for DNS-level ISP blocking. The OS resolver stays
// the primary path; only when it fails with a DNS error (NXDOMAIN, SERVFAIL,
// refused, resolver timeout) is the host re-resolved over DoH to hardcoded
// resolver IPs and dialed directly. TLS verification still runs against the
// original hostname, so a bad answer cannot silently redirect traffic.

var dohUpstreams = []string{
	"https://1.1.1.1/dns-query",
	"https://8.8.8.8/dns-query",
}

// Upstream URLs are literal IPs, so this client never needs DNS itself.
var dohClient = &http.Client{
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		MaxIdleConnsPerHost: 1,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
		ForceAttemptHTTP2:   true,
		TLSClientConfig:     newTLSCompatibilityConfig(false),
	},
	Timeout: 10 * time.Second,
}

const (
	dohCacheMaxEntries = 256
	dohCacheMinTTL     = time.Minute
	dohCacheMaxTTL     = 30 * time.Minute
	dohCacheErrorTTL   = 30 * time.Second
)

type dohCacheEntry struct {
	ips       []net.IP
	expiresAt time.Time
}

var (
	dohMu    sync.Mutex
	dohCache = map[string]dohCacheEntry{}
)

// dialWithDoHFallback dials addr normally and, when the failure is a DNS
// error, retries with DoH-resolved addresses. Non-DNS failures pass through
// untouched.
func dialWithDoHFallback(ctx context.Context, dialer *net.Dialer, network, addr string) (net.Conn, error) {
	conn, err := dialer.DialContext(ctx, network, addr)
	if err == nil {
		return conn, nil
	}
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) {
		return nil, err
	}
	host, port, splitErr := net.SplitHostPort(addr)
	if splitErr != nil || net.ParseIP(host) != nil {
		return nil, err
	}
	ips, dohErr := dohResolve(ctx, host)
	if dohErr != nil {
		// Surface the OS resolver's error, not the fallback's.
		return nil, err
	}
	GoLog("[DoH] OS resolver failed for %s (%v), dialing DoH answer\n", host, err)
	lastErr := err
	for _, ip := range ips {
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

// dohResolve resolves host over DoH, IPv4 first. Failures are negative-cached
// briefly so a burst of dials does not hammer the resolvers.
func dohResolve(ctx context.Context, host string) ([]net.IP, error) {
	if ips, ok := dohCachedIPs(host); ok {
		if len(ips) == 0 {
			return nil, fmt.Errorf("doh: cached failure for %s", host)
		}
		return ips, nil
	}

	var lastErr error
	for _, upstream := range dohUpstreams {
		ips, ttl, err := dohQuery(ctx, upstream, host, dnsmessage.TypeA)
		if err == nil && len(ips) == 0 {
			ips, ttl, err = dohQuery(ctx, upstream, host, dnsmessage.TypeAAAA)
		}
		if err != nil {
			lastErr = err
			continue
		}
		ips = filterDialableIPs(ips)
		if len(ips) == 0 {
			break
		}
		dohCachePut(host, ips, min(max(ttl, dohCacheMinTTL), dohCacheMaxTTL))
		return ips, nil
	}
	dohCachePut(host, nil, dohCacheErrorTTL)
	if lastErr == nil {
		lastErr = fmt.Errorf("doh: no address for %s", host)
	}
	return nil, lastErr
}

func dohQuery(ctx context.Context, upstream, host string, qtype dnsmessage.Type) ([]net.IP, time.Duration, error) {
	name, err := dnsmessage.NewName(host + ".")
	if err != nil {
		return nil, 0, fmt.Errorf("doh: invalid host %q: %w", host, err)
	}
	msg := dnsmessage.Message{
		Header: dnsmessage.Header{RecursionDesired: true},
		Questions: []dnsmessage.Question{{
			Name:  name,
			Type:  qtype,
			Class: dnsmessage.ClassINET,
		}},
	}
	packed, err := msg.Pack()
	if err != nil {
		return nil, 0, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream, bytes.NewReader(packed))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")

	resp, err := dohClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("doh: %s answered HTTP %d", upstream, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, 0, err
	}

	var reply dnsmessage.Message
	if err := reply.Unpack(body); err != nil {
		return nil, 0, err
	}
	if reply.RCode != dnsmessage.RCodeSuccess {
		return nil, 0, fmt.Errorf("doh: rcode %v for %s", reply.RCode, host)
	}

	var ips []net.IP
	ttl := dohCacheMaxTTL
	for _, ans := range reply.Answers {
		var ip net.IP
		switch r := ans.Body.(type) {
		case *dnsmessage.AResource:
			ip = net.IP(r.A[:])
		case *dnsmessage.AAAAResource:
			ip = net.IP(r.AAAA[:])
		default:
			continue
		}
		ips = append(ips, ip)
		if t := time.Duration(ans.Header.TTL) * time.Second; t < ttl {
			ttl = t
		}
	}
	return ips, ttl, nil
}

// filterDialableIPs drops private/loopback/link-local answers unless the user
// opted into private-network access — a DoH answer must not bypass the SSRF
// guard the OS-resolver path enforces.
func filterDialableIPs(ips []net.IP) []net.IP {
	if IsPrivateNetworkAllowed() {
		return ips
	}
	kept := ips[:0]
	for _, ip := range ips {
		if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			continue
		}
		kept = append(kept, ip)
	}
	return kept
}

func dohCachedIPs(host string) ([]net.IP, bool) {
	dohMu.Lock()
	defer dohMu.Unlock()
	e, ok := dohCache[host]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.ips, true
}

func dohCachePut(host string, ips []net.IP, ttl time.Duration) {
	dohMu.Lock()
	defer dohMu.Unlock()
	if len(dohCache) >= dohCacheMaxEntries {
		now := time.Now()
		for k, e := range dohCache {
			if now.After(e.expiresAt) {
				delete(dohCache, k)
			}
		}
		for k := range dohCache {
			if len(dohCache) < dohCacheMaxEntries {
				break
			}
			delete(dohCache, k)
		}
	}
	dohCache[host] = dohCacheEntry{ips: ips, expiresAt: time.Now().Add(ttl)}
}
