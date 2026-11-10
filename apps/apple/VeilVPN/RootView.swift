import SwiftUI
import UniformTypeIdentifiers
import VeilVPNKit

struct RootView: View {
    @Bindable var model: VeilModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch model.tab {
                    case .connect: ConnectScreen(model: model)
                    case .servers: ServersScreen(model: model)
                    case .earn: EarnScreen(model: model)
                    case .revenue: RevenueScreen(model: model)
                    case .settings: SettingsScreen(model: model)
                    }
                }
                .padding(.horizontal, compact ? 16 : 48)
                .padding(.top, 20)
                .padding(.bottom, compact ? 24 : 48)
                .frame(maxWidth: 1040)
                .frame(maxWidth: .infinity)
            }
        }
        .background(VeilColor.paper)
        .font(.veil(16))
        .foregroundStyle(VeilColor.ink)
        .safeAreaInset(edge: .bottom) { if compact { bottomBar } }
        .overlay(alignment: .bottom) { toast }
        .onChange(of: model.tab) { _, tab in
            if tab == .earn { Task { await model.loadPool() } }
            if tab == .revenue { Task { await model.loadRevenue() } }
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 560)
        #endif
    }

    private var header: some View {
        HStack(spacing: 28) {
            Button { model.tab = .connect } label: { Wordmark() }.buttonStyle(.plain)
            Spacer()
            if !compact {
                HStack(spacing: 28) {
                    ForEach(AppTab.allCases) { tab in
                        tabButton(tab)
                    }
                }
            }
        }
        .padding(.horizontal, compact ? 16 : 48)
        .frame(minHeight: 52)
        .background(VeilColor.paper)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var bottomBar: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases) { tab in
                Button { model.tab = tab } label: {
                    VStack(spacing: 3) {
                        TabGlyph(tab: tab)
                        Text(tab == .servers ? "Locations" : tab.title)
                            .font(.veil(11))
                    }
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(model.tab == tab ? VeilColor.ink : VeilColor.muted)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("nav-\(tab.rawValue)")
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 6)
        .background(VeilColor.paper)
        .overlay(alignment: .top) { Hairline() }
    }

    private func tabButton(_ tab: AppTab) -> some View {
        Button { model.tab = tab } label: {
            Text(tab == .servers ? "Locations" : tab.title)
                .font(.veil(13))
                .foregroundStyle(model.tab == tab ? VeilColor.ink : VeilColor.muted)
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(VeilColor.ink).frame(height: 2).opacity(model.tab == tab ? 1 : 0)
                }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("nav-\(tab.rawValue)")
    }

    @ViewBuilder private var toast: some View {
        if let text = model.toast {
            Text(text)
                .font(.veil(14))
                .foregroundStyle(VeilColor.paper)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(VeilColor.ink)
                .padding(.bottom, compact ? 88 : 24)
                .accessibilityIdentifier("toast")
        }
    }
}

struct ConnectScreen: View {
    @Bindable var model: VeilModel
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.link.state == .on ? VeilCopy.ipLine(state: .on, tor: model.link.tor, killSwitch: model.settings.kill) : VeilCopy.ipLine(state: model.link.state, tor: false, killSwitch: model.settings.kill))
                Spacer()
                Text(VeilCopy.protoLabel(model.link.state == .off ? model.settings.tunnelProto : model.link.proto))
            }
            .font(.veil(12))
            .foregroundStyle(VeilColor.muted)
            Text(VeilCopy.statusWord(model.link.state))
                .font(.veil(sizeClass == .compact ? 44 : 64))
                .tracking(sizeClass == .compact ? -2.2 : -3.2)
                .padding(.top, 24)
                .accessibilityIdentifier("status-word")
            Text(model.selected.map { "\($0.city)." } ?? "Choose a location.")
                .font(.veil(sizeClass == .compact ? 44 : 64))
                .tracking(sizeClass == .compact ? -2.2 : -3.2)
                .foregroundStyle(VeilColor.grey)
            HStack(spacing: 12) {
                Button { Task { await model.togglePower() } } label: {
                    HStack {
                        Text(VeilCopy.powerLabel(model.link.state))
                        Spacer()
                        Text("↗")
                    }
                    .font(.veil(13))
                    .foregroundStyle(VeilColor.paper)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: sizeClass == .compact ? .infinity : 280)
                    .background(powerColor)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("power")
                Button { model.tab = .servers } label: {
                    HStack(spacing: 12) {
                        Text(model.selected.map { countryCode(from: $0.flag) } ?? "—")
                            .font(.system(size: 12, design: .monospaced))
                        Text(model.selected.map { "\($0.city), \($0.country)" } ?? "Choose a location")
                            .lineLimit(1)
                        Spacer()
                        Text("+")
                    }
                    .font(.veil(13))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .overlay(Rectangle().stroke(VeilColor.ink, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("location")
            }
            .padding(.top, 28)
            if let line = model.networkLine {
                HStack(spacing: 8) {
                    Circle().fill(model.networkWarn ? VeilColor.warn : VeilColor.ink).frame(width: 8, height: 8)
                    Text(line).font(.veil(13)).foregroundStyle(model.networkWarn ? VeilColor.warn : VeilColor.ink)
                }
                .padding(.top, 28)
                .accessibilityIdentifier("network")
            }
            HStack(spacing: 8) {
                Circle().fill(model.link.state == .on && model.settings.block ? VeilColor.ink : VeilColor.line).frame(width: 8, height: 8)
                Text(VeilCopy.shield(block: model.settings.block, connected: model.link.state == .on, blocked: model.blocked).text)
                    .font(.veil(13))
                Spacer()
                Text(VeilCopy.shield(block: model.settings.block, connected: model.link.state == .on, blocked: model.blocked).count)
                    .font(.system(size: 13, design: .monospaced))
            }
            .foregroundStyle(model.link.state == .on && model.settings.block ? VeilColor.ink : VeilColor.muted)
            .padding(.top, model.networkLine == nil ? 28 : 8)
            stats
            meter
            if let ad = model.ad {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Sponsored").font(.veil(13)).foregroundStyle(VeilColor.muted)
                    Button {
                        model.openAd()
                        if let raw = ad.url, let url = URL(string: raw) { openURL(url) }
                    } label: {
                        HStack(spacing: 16) {
                            Text(ad.mark).font(.veil(12)).frame(width: 32, height: 32).overlay(Rectangle().stroke(VeilColor.ink, lineWidth: 1))
                            Text(ad.title).font(.veil(14)) + Text("  " + ad.body).font(.veil(14)).foregroundColor(VeilColor.muted)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .padding(.vertical, 14)
                .overlay(alignment: .top) { Hairline() }
                .overlay(alignment: .bottom) { Hairline() }
                .padding(.top, 32)
            }
        }
    }

    private var powerColor: Color {
        switch model.link.state {
        case .connecting: return VeilColor.muted
        case .error: return VeilColor.warn
        case .off, .on: return VeilColor.ink
        }
    }

    private var stats: some View {
        let columns = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        let wide = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        return LazyVGrid(columns: sizeClass == .compact ? columns : wide, alignment: .leading, spacing: 0) {
            stat("Session", model.sessionClock)
            stat("Down", model.link.state == .on ? VeilFormat.megabytes(bytes: Double(model.link.rx)) : "0.0 MB")
            stat("Up", model.link.state == .on ? VeilFormat.megabytes(bytes: Double(model.link.tx)) : "0.0 MB")
            stat("Today", VeilFormat.fixed(model.account?.todayVeil ?? 0, digits: 2) + " $VEIL")
        }
        .padding(.top, 20)
        .overlay(alignment: .top) { Hairline() }
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.veil(13)).foregroundStyle(VeilColor.muted)
            Text(value).font(.system(size: 17, design: .monospaced))
        }
        .padding(.vertical, 14)
    }

    private var meter: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(VeilColor.line)
                Rectangle().fill(VeilColor.ink).frame(width: geo.size.width * min(1, (model.account?.todayVeil ?? 0) / VeilEconomics.maxDay))
            }
        }
        .frame(height: 2)
        .accessibilityLabel("Daily reward limit")
    }
}

struct ServersScreen: View {
    @Bindable var model: VeilModel
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Locations")
                Spacer()
                Text("\(model.servers.count)")
            }
            .font(.veil(12))
            .foregroundStyle(VeilColor.muted)
            Text("Choose a location.")
                .font(.veil(44))
                .tracking(-2)
                .padding(.vertical, 24)
                .accessibilityIdentifier("locations-title")
            TextField("Search", text: $model.search)
                .font(.veil(18))
                .multilineTextAlignment(.center)
                .textFieldStyle(.plain)
                .padding(.vertical, 14)
                .overlay(alignment: .bottom) { Rectangle().fill(VeilColor.ink).frame(height: 1) }
                .accessibilityIdentifier("server-search")
            if model.filteredServers.isEmpty {
                Text("No match.").font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.vertical, 16)
            }
            ForEach(model.filteredServers) { server in
                Button { Task { await model.choose(server) } } label: {
                    HStack(spacing: 16) {
                        Text(countryCode(from: server.flag)).font(.system(size: 12, design: .monospaced)).frame(width: 32, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(server.city).font(.veil(15))
                            Text(server.country + (server.tor ? " · Tor" : "") + (server.online ? "" : " · offline"))
                                .font(.veil(14)).foregroundStyle(VeilColor.muted)
                        }
                        Spacer()
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(VeilColor.line)
                                Rectangle().fill(VeilColor.muted).frame(width: geo.size.width * CGFloat(server.load) / 100)
                            }
                        }
                        .frame(width: 48, height: 2)
                        Text("\(server.load)%").font(.system(size: 12, design: .monospaced)).foregroundStyle(VeilColor.muted).frame(width: 40, alignment: .trailing)
                    }
                    .padding(.vertical, 13)
                    .overlay(alignment: .bottom) { Hairline() }
                    .foregroundStyle(model.selectedID == server.id ? VeilColor.ink : VeilColor.ink)
                    .opacity(server.online ? 1 : 0.4)
                }
                .buttonStyle(.plain)
                .disabled(!server.online)
            }
        }
    }
}

struct EarnScreen: View {
    @Bindable var model: VeilModel
    var body: some View {
        let share = estimatedShare
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("$VEIL")
                Spacer()
                Text("Solana")
            }
            .font(.veil(12)).foregroundStyle(VeilColor.muted)
            Text("Use. ").font(.veil(44)) + Text("Earn.").font(.veil(44)).foregroundColor(VeilColor.grey)
            kpis([
                ("Today", VeilFormat.fixed(model.account?.todayVeil ?? 0, digits: 2)),
                ("Pending", VeilFormat.fixed(model.account?.pending ?? 0, digits: 2)),
                ("Ad share", VeilFormat.fixed(share, digits: 2)),
                ("Lifetime", VeilFormat.fixed(model.account?.lifetime ?? 0, digits: 2)),
            ])
            if let hold = VeilCopy.hold(model.account?.hold) {
                Text(hold).font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.top, 16)
            }
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("FIRM Wallet").font(.veil(13)).foregroundStyle(VeilColor.muted)
                    Text(walletLine).font(.system(size: 18, design: .monospaced))
                }
                Spacer()
                PrimaryButton(title: "Claim") { Task { await model.claim() } }
                    .frame(width: 160)
                    .opacity((model.account?.wallet == nil) || (model.account?.claimable ?? 0) <= 0.0001 ? 0.3 : 1)
                    .allowsHitTesting((model.account?.wallet != nil) && (model.account?.claimable ?? 0) > 0.0001)
            }
            .padding(.top, 40)
            .overlay(alignment: .top) { Hairline() }
            Text("$VEIL is not equity, income or an investment return.")
                .font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.top, 16)
        }
        .accessibilityIdentifier("earn-title")
    }

    private var estimatedShare: Double {
        guard let pool = model.pool, let account = model.account else { return 0 }
        return VeilEconomics.memberShare(
            poolUsd: pool.poolUsd,
            myMinutes: Double(account.todayMinutes),
            totalMinutes: max(pool.minutes, Double(account.todayMinutes)),
            boost: pool.boost,
            price: pool.refPrice
        ).veil
    }

    private var walletLine: String {
        guard let wallet = model.account?.wallet, wallet.count > 12 else { return "Not linked" }
        return "\(wallet.prefix(6))…\(wallet.suffix(6))"
    }

    private func kpis(_ items: [(String, String)]) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading) {
            ForEach(items, id: \.0) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.0).font(.veil(13)).foregroundStyle(VeilColor.muted)
                    Text(item.1).font(.system(size: 22, design: .monospaced))
                }
                .padding(.vertical, 14)
            }
        }
        .padding(.top, 8)
        .overlay(alignment: .top) { Hairline() }
    }
}

struct RevenueScreen: View {
    @Bindable var model: VeilModel
    var body: some View {
        let today = model.revenue?.today
        let tier = VeilEconomics.tier(members: today?.members ?? 0)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Epoch \(VeilEconomics.epochNumber())")
                Spacer()
                Text(today?.revenueSource == "reported" ? "Reported" : "Estimated")
            }
            .font(.veil(12)).foregroundStyle(VeilColor.muted)
            Text("Ad revenue. ").font(.veil(44)) + Text("Shared.").font(.veil(44)).foregroundColor(VeilColor.grey)
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading) {
                kpi("Today", today.map { VeilFormat.usd($0.revenueUsd) } ?? "—", today.map { VeilFormat.plural($0.views, "view") + " · " + VeilFormat.plural($0.clicks, "click") } ?? "")
                kpi("Community pool", today.map { VeilFormat.usd($0.poolUsd) } ?? "—", today.map { "\(Int($0.communityPercent))% · \($0.tier)" } ?? "")
                kpi("Your ads", model.revenue.map { VeilFormat.usd($0.mineUSD) } ?? "—", model.revenue.map { VeilFormat.plural($0.mineViews, "view") + " · " + VeilFormat.plural($0.mineClicks, "click") } ?? "")
                kpi("Your share", model.revenue.map { VeilFormat.fixed($0.shareVeil, digits: 2) } ?? "—", model.revenue.map { "$VEIL · " + VeilFormat.weightPercent($0.weight) } ?? "")
            }
            .overlay(alignment: .top) { Hairline() }
            Text("Split").font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.top, 44)
            splitBar(tier)
            legend(tier)
            Text("Payouts").font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.top, 32)
            payouts
            Text("Tiers").font(.veil(13)).foregroundStyle(VeilColor.muted).padding(.top, 32)
            tiers(current: tier)
            HStack {
                Text("Grow the pool").font(.veil(13)).foregroundStyle(VeilColor.muted)
                Spacer()
                PrimaryButton(title: "Copy invite link") { model.copyInvite() }.frame(width: 220)
            }
            .padding(.top, 40)
            .overlay(alignment: .top) { Hairline() }
        }
    }

    private func kpi(_ title: String, _ value: String, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.veil(13)).foregroundStyle(VeilColor.muted)
            Text(value).font(.system(size: 22, design: .monospaced))
            Text(sub).font(.veil(13)).foregroundStyle(VeilColor.muted)
        }
        .padding(.vertical, 14)
    }

    private func splitBar(_ tier: VeilEconomics.Tier) -> some View {
        let colors = [VeilColor.ink, Color(hex: VeilBrand.splitNetwork), Color(hex: VeilBrand.splitEcosystem), Color(hex: VeilBrand.splitLiquidity), VeilColor.ink]
        return HStack(spacing: 2) {
            ForEach(Array(tier.percents.enumerated()), id: \.offset) { index, width in
                Rectangle().fill(colors[index]).frame(maxWidth: .infinity).frame(width: nil).layoutPriority(Double(width))
            }
        }
        .frame(height: 6)
        .padding(.top, 12)
    }

    private func legend(_ tier: VeilEconomics.Tier) -> some View {
        let names = ["Community", "Network", "Ecosystem", "Liquidity", "Team"]
        let colors = [VeilColor.ink, Color(hex: VeilBrand.splitNetwork), Color(hex: VeilBrand.splitEcosystem), Color(hex: VeilBrand.splitLiquidity), VeilColor.ink]
        return LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading) {
            ForEach(Array(names.enumerated()), id: \.offset) { index, name in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(tier.percents[index])%").font(.veil(20))
                    HStack(spacing: 8) {
                        Rectangle().fill(colors[index]).frame(width: 8, height: 8)
                        Text(name).font(.veil(13)).foregroundStyle(VeilColor.muted)
                    }
                }
                .padding(.top, 12)
            }
        }
    }

    private var payouts: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Day"); Spacer(); Text("Revenue"); Text("Pool").frame(width: 72, alignment: .trailing); Text("Minutes").frame(width: 64, alignment: .trailing); Text("You").frame(width: 64, alignment: .trailing)
            }
            .font(.veil(13)).foregroundStyle(VeilColor.muted)
            .padding(.vertical, 10)
            .overlay(alignment: .top) { Hairline() }
            if model.revenue?.history.isEmpty != false {
                Text("None yet").font(.veil(14)).foregroundStyle(VeilColor.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
            }
            ForEach(model.revenue?.history ?? [], id: \.day) { row in
                HStack {
                    Text(String(row.day.dropFirst(min(5, row.day.count)))).frame(width: 56, alignment: .leading)
                    Spacer()
                    Text(VeilFormat.usd(row.revenueUsd))
                    Text(VeilFormat.usd(row.poolUsd)).frame(width: 72, alignment: .trailing)
                    Text("\(row.minutes)").frame(width: 64, alignment: .trailing)
                    Text(row.minutes > 0 ? VeilFormat.fixed(row.myVeil, digits: 2) : "—").frame(width: 64, alignment: .trailing)
                }
                .font(.system(size: 14, design: .monospaced))
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { Hairline() }
            }
        }
    }

    private func tiers(current: VeilEconomics.Tier) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(VeilEconomics.tiers.enumerated()), id: \.offset) { index, tier in
                HStack {
                    Text(tier.name).frame(width: 80, alignment: .leading)
                    Text(VeilEconomics.memberRange(index: index)).font(.system(size: 14, design: .monospaced))
                    Spacer()
                    Text("\(tier.community)%")
                    Text(String(format: "%.2f×", tier.boost)).frame(width: 56, alignment: .trailing)
                }
                .font(.veil(14))
                .foregroundStyle(tier.name == current.name ? VeilColor.ink : VeilColor.muted)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { Hairline() }
            }
        }
    }
}

struct SettingsScreen: View {
    @Bindable var model: VeilModel
    @Environment(\.openURL) private var openURL
    @State private var importing = false
    @State private var exportFile: SetupFile?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Settings")
                Spacer()
                Text("On this device")
            }
            .font(.veil(12)).foregroundStyle(VeilColor.muted)
            Text("Settings.")
                .font(.veil(44))
                .tracking(-2)
                .padding(.vertical, 24)
                .accessibilityIdentifier("settings-title")
            row("Block trackers", detail: "Ads, analytics and data collectors, for every app", on: model.settings.block) { Task { await model.toggle("block") } }
            row("Unsafe network alerts", detail: "A notification when you join Wi-Fi while not protected", on: model.settings.alerts) { Task { await model.toggle("alerts") } }
            row("Kill switch", detail: nil, on: model.settings.kill) { Task { await model.toggle("kill") } }
            row("Tor over VPN", detail: nil, on: model.settings.tor) { Task { await model.toggle("tor") } }
            row("Connect on launch", detail: nil, on: model.settings.auto) { Task { await model.toggle("auto") } }
            row("Earn $VEIL", detail: nil, on: model.settings.earn) { Task { await model.toggle("earn") } }
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Protocol").font(.veil(15))
                    Text(VeilCopy.protoHint(model.settings.tunnelProto)).font(.veil(12)).foregroundStyle(VeilColor.muted)
                }
                Spacer()
                Picker("Protocol", selection: Binding(get: { model.settings.tunnelProto }, set: { value in Task { await model.setProto(value) } })) {
                    Text("WireGuard").tag("wireguard")
                    Text("IKEv2/IPsec").tag("ikev2")
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }
            .padding(.vertical, 13)
            .overlay(alignment: .bottom) { Hairline() }
            row("VLESS", detail: "XTLS Reality, for networks that block VPNs. Off until you turn it on. Used from Other devices.", on: model.settings.vless) { Task { await model.toggle("vless") } }
            row("Shadowsocks", detail: "Shadowsocks-2022. Off until you turn it on. Used from Other devices.", on: model.settings.shadowsocks) { Task { await model.toggle("shadowsocks") } }
            row("WebSocket on 443", detail: "VLESS and Shadowsocks over WebSocket and TLS, including behind a CDN. Off until you turn it on.", on: model.settings.ws) { Task { await model.toggle("ws") } }
            wallet
            devices
            firm
            cantSee
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data, .text]) { result in
            guard case .success(let url) = result else { return }
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
            Task { await model.importConfig(text) }
        }
        .fileExporter(isPresented: Binding(get: { exportFile != nil }, set: { if !$0 { exportFile = nil } }), document: TextExport(text: exportFile?.text ?? ""), contentType: .data, defaultFilename: exportFile?.filename) { _ in }
    }

    private func row(_ title: String, detail: String?, on: Bool, action: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.veil(15))
                if let detail { Text(detail).font(.veil(12)).foregroundStyle(VeilColor.muted) }
            }
            Spacer()
            VeilSwitch(on: on, label: title, action: action)
        }
        .padding(.vertical, 13)
        .overlay(alignment: .top) { Hairline() }
    }

    private var wallet: some View {
        HStack {
            Text("FIRM Wallet").font(.veil(15))
            Spacer()
            TextField("Solana address", text: $model.walletDraft)
                .font(.system(size: 13, design: .monospaced))
                .textFieldStyle(.plain)
                .disabled(model.account?.wallet != nil)
                .overlay(alignment: .bottom) { Hairline() }
                .frame(maxWidth: 280)
            GhostButton(title: model.account?.wallet == nil ? "Link" : "Unlink") { Task { await model.submitWallet() } }
        }
        .padding(.vertical, 13)
        .overlay(alignment: .top) { Hairline() }
        .onAppear { model.walletDraft = model.account?.wallet ?? "" }
    }

    private var devices: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Other devices").font(.veil(15)).padding(.top, 28)
            Text("Use VEIL on a laptop, iPhone, Mac, PC or router with a standard VPN app or the one built in. A set-up uses the location picked above, lasts 7 days and does not earn $VEIL. VLESS and Shadowsocks stay hidden until you turn them on above. Import them into Xray, v2rayNG or sing-box. This app's own tunnel stays WireGuard or IKEv2.")
                .font(.veil(14)).foregroundStyle(VeilColor.muted)
            Picker("Set-up type", selection: $model.deviceMode) {
                ForEach(ManualSetup.deviceModes(vless: model.settings.vless, shadowsocks: model.settings.shadowsocks, webSocket: model.settings.ws), id: \.0) { mode in
                    Text(mode.1).tag(mode.0)
                }
            }
            .labelsHidden()
            HStack {
                GhostButton(title: "Get set-up") { Task { await model.prepareDeviceSetup() } }
                GhostButton(title: "Import .conf") { importing = true }
            }
            if let setup = model.setup {
                Text(setup.summary).font(.veil(14)).padding(.top, 8)
                ForEach(Array(setup.fields.enumerated()), id: \.offset) { _, field in
                    HStack(alignment: .top) {
                        Text(field.label).foregroundStyle(VeilColor.muted).frame(width: 90, alignment: .leading)
                        Text(field.value).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                    }
                    .font(.veil(14))
                }
                ForEach(model.setupFiles, id: \.filename) { file in
                    GhostButton(title: "Save \(file.filename)") { exportFile = file }
                }
            }
        }
    }

    private var firm: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("FIRM Wallet™").font(.veil(16))
                Spacer()
                Text("COMING SOON").font(.veil(11)).tracking(1.2).foregroundStyle(VeilColor.firmMuted)
            }
            Text("Self-custody for Solana, Ethereum and Base. Early access is open.")
                .font(.veil(13)).foregroundStyle(VeilColor.firmMuted)
            HStack(spacing: 8) {
                Button { openURL(VeilBrand.firmWalletURL) } label: {
                    Text("Get early access").font(.veil(13)).foregroundStyle(VeilColor.paper).padding(.horizontal, 14).frame(height: 36).background(VeilColor.firmInk)
                }
                .buttonStyle(.plain)
                Button { openURL(VeilBrand.firmamentURL) } label: {
                    Text("Firmament Network™ CPO ↗").font(.veil(13)).padding(.horizontal, 14).frame(height: 36).overlay(Rectangle().stroke(VeilColor.firmInk, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .overlay(Rectangle().stroke(VeilColor.firmLine, lineWidth: 1))
        .padding(.top, 28)
        .accessibilityIdentifier("firm-suite")
    }

    private var cantSee: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                bullet("The sites and apps you use.", "Servers keep no traffic or DNS logs. Blocked trackers are only counted, never named.")
                bullet("What you send.", "Your traffic is encrypted from your device to our server, and HTTPS sites stay encrypted beyond it.")
                bullet("Who you are.", "No account, email or phone number. Your IP address is never written to disk.")
                bullet("Your Wi-Fi.", "Network checks and alerts run on your device. The network's name is never read.")
                bullet("Where Tor sends your traffic.", "With Tor on, our server sees only that you use Tor.")
                Text("We keep an anonymous session, minutes connected, ad view counts, a hashed device ID (one earning account per device) and, if you link one, your wallet address.")
                    .font(.veil(14)).foregroundStyle(VeilColor.muted)
                Button("Privacy policy") { openURL(VeilBrand.privacyURL) }
                    .font(.veil(14))
                    .buttonStyle(.plain)
            }
            .padding(.top, 14)
        } label: {
            Text("What Infinitum can't see").font(.veil(15))
        }
        .padding(.top, 28)
        .tint(VeilColor.ink)
    }

    private func bullet(_ title: String, _ body: String) -> some View {
        Text(title).font(.veil(14)) + Text(" " + body).font(.veil(14)).foregroundColor(VeilColor.muted)
    }
}

struct TextExport: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = "" }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
