package gobackend

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestSimpleCookieJarReplacesAndExpiresCookies(t *testing.T) {
	jar, err := newSimpleCookieJar()
	if err != nil {
		t.Fatalf("newSimpleCookieJar: %v", err)
	}
	u, _ := url.Parse("https://api.example.com/path")

	jar.SetCookies(u, []*http.Cookie{{Name: "session", Value: "old", Path: "/"}})
	jar.SetCookies(u, []*http.Cookie{{Name: "session", Value: "new", Path: "/"}})
	cookies := jar.Cookies(u)
	if len(cookies) != 1 || cookies[0].Value != "new" {
		t.Fatalf("replacement cookies = %#v", cookies)
	}

	jar.SetCookies(u, []*http.Cookie{{
		Name:    "session",
		Value:   "expired",
		Path:    "/",
		Expires: time.Now().Add(-time.Hour),
		MaxAge:  -1,
	}})
	if cookies := jar.Cookies(u); len(cookies) != 0 {
		t.Fatalf("expired cookies = %#v", cookies)
	}
}

func TestSimpleCookieJarClearAndScope(t *testing.T) {
	jar, err := newSimpleCookieJar()
	if err != nil {
		t.Fatalf("newSimpleCookieJar: %v", err)
	}
	apiURL, _ := url.Parse("https://api.example.com/private/resource")
	otherURL, _ := url.Parse("https://other.example.com/private/resource")
	publicURL, _ := url.Parse("https://api.example.com/public")

	jar.SetCookies(apiURL, []*http.Cookie{{Name: "session", Value: "value", Path: "/private"}})
	if len(jar.Cookies(apiURL)) != 1 {
		t.Fatal("expected cookie for matching host and path")
	}
	if len(jar.Cookies(otherURL)) != 0 || len(jar.Cookies(publicURL)) != 0 {
		t.Fatal("cookie escaped its host or path scope")
	}

	jar.Clear()
	if len(jar.Cookies(apiURL)) != 0 {
		t.Fatal("Clear retained cookies")
	}
}
