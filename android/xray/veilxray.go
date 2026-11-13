// Package veilxray runs Xray-core inside the VEIL VPN Android app, for VLESS Reality on networks that block
// WireGuard (Russia's TSPU lets the WireGuard handshake through and then drops the data).
//
// The app's VpnService hands over its TUN file descriptor; Xray's own "tun" inbound reads it (xray.tun.fd)
// and every flow leaves through the node's VLESS outbound. The app excludes itself from its VPN, so Xray's
// sockets to the node go out over the real network instead of looping back into the TUN.
//
// Built into android/app/libs/veilxray.aar by scripts/build-xray-aar.ps1 (gomobile bind).
package veilxray

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/outbound"
	"github.com/xtls/xray-core/infra/conf"
	_ "github.com/xtls/xray-core/main/distro/all"
)

var (
	mu   sync.Mutex
	inst *core.Instance
)

// Start runs Xray with the given JSON config, reading packets from the TUN file descriptor fd.
// A running instance is stopped first.
func Start(fd int, config string) error {
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
	os.Setenv("xray.tun.fd", strconv.Itoa(fd))
	os.Setenv("XRAY_TUN_FD", strconv.Itoa(fd))
	cfg, err := core.LoadConfig("json", strings.NewReader(config))
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	i, err := core.New(cfg)
	if err != nil {
		return fmt.Errorf("new: %w", err)
	}
	if err := i.Start(); err != nil {
		i.Close()
		return fmt.Errorf("start: %w", err)
	}
	inst = i
	return nil
}

// Stop ends Xray. The TUN descriptor itself stays with the app, which closes it.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
}

func stopLocked() {
	if inst != nil {
		inst.Close()
		inst = nil
	}
}

// Running reports whether Xray is up.
func Running() bool {
	mu.Lock()
	defer mu.Unlock()
	return inst != nil
}

// UpdateOutbound swaps the outbound tagged in the given JSON (one Xray outbound object) for a new one, without
// restarting Xray: connections already open keep the old handler, new ones use the new handler. The app uses it to
// put a fresh proxy token in place before the old one expires.
func UpdateOutbound(outboundJSON string) error {
	mu.Lock()
	defer mu.Unlock()
	if inst == nil {
		return errors.New("not running")
	}
	var oc conf.OutboundDetourConfig
	if err := json.Unmarshal([]byte(outboundJSON), &oc); err != nil {
		return fmt.Errorf("outbound: %w", err)
	}
	built, err := oc.Build()
	if err != nil {
		return fmt.Errorf("outbound: %w", err)
	}
	om, ok := inst.GetFeature(outbound.ManagerType()).(outbound.Manager)
	if !ok {
		return errors.New("no outbound manager")
	}
	_ = om.RemoveHandler(context.Background(), built.Tag)
	return core.AddOutboundHandler(inst, built)
}

// Probe fetches https://1.1.1.1/cdn-cgi/trace through the VLESS outbound and returns how long it took in
// milliseconds. It proves that data really flows both ways, not just that a connection opened.
func Probe(timeoutMs int) (int64, error) {
	mu.Lock()
	i := inst
	mu.Unlock()
	if i == nil {
		return 0, errors.New("not running")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	start := time.Now()
	c, err := core.Dial(ctx, i, xnet.TCPDestination(xnet.ParseAddress("1.1.1.1"), xnet.Port(443)))
	if err != nil {
		return 0, err
	}
	defer c.Close()
	if d, ok := ctx.Deadline(); ok {
		c.SetDeadline(d)
	}
	t := tls.Client(c, &tls.Config{ServerName: "one.one.one.one"})
	if err := t.HandshakeContext(ctx); err != nil {
		return 0, err
	}
	if _, err := t.Write([]byte("GET /cdn-cgi/trace HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n")); err != nil {
		return 0, err
	}
	line, err := bufio.NewReader(t).ReadString('\n')
	if err != nil {
		return 0, err
	}
	if !strings.Contains(line, " 200 ") {
		return 0, fmt.Errorf("probe: %s", strings.TrimSpace(line))
	}
	return time.Since(start).Milliseconds(), nil
}

// Version is the bundled Xray-core version.
func Version() string { return core.Version() }
