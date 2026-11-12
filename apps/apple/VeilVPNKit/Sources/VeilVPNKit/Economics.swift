import Foundation

/// Reward rules from `shared/economics.js`. The numbers have to match the control server.
public enum VeilEconomics {
    public static let ratePerMinute = 0.1
    public static let maxMinutes = 240
    public static let maxDay = ratePerMinute * Double(maxMinutes)
    public static let refPrice = 0.01

    public struct Tier: Equatable, Sendable {
        public var name: String
        public var minMembers: Int
        public var community: Int
        public var network: Int
        public var ecosystem: Int
        public var liquidity: Int
        public var team: Int
        public var boost: Double
        public var percents: [Int] { [community, network, ecosystem, liquidity, team] }
    }

    public static let tiers: [Tier] = [
        Tier(name: "Launch", minMembers: 0, community: 50, network: 20, ecosystem: 15, liquidity: 10, team: 5, boost: 1.0),
        Tier(name: "Growth", minMembers: 100_000, community: 55, network: 17, ecosystem: 13, liquidity: 10, team: 5, boost: 1.25),
        Tier(name: "Network", minMembers: 1_000_000, community: 60, network: 15, ecosystem: 10, liquidity: 10, team: 5, boost: 1.5),
        Tier(name: "Mass", minMembers: 10_000_000, community: 65, network: 12, ecosystem: 8, liquidity: 10, team: 5, boost: 2.0),
    ]

    public static func tier(members: Double) -> Tier {
        tiers.reduce(tiers[0]) { current, next in
            members >= Double(next.minMembers) ? next : current
        }
    }

    public struct Split: Equatable, Sendable {
        public var tier: String
        public var boost: Double
        public var percent: [String: Int]
        public var usd: [String: Double]
    }

    public static func split(members: Double, revenueUsd: Double) -> Split {
        let t = tier(members: members)
        func part(_ p: Int) -> Double { revenueUsd * Double(p) / 100 }
        return Split(
            tier: t.name,
            boost: t.boost,
            percent: ["community": t.community, "network": t.network, "ecosystem": t.ecosystem, "liquidity": t.liquidity, "team": t.team],
            usd: ["community": part(t.community), "network": part(t.network), "ecosystem": part(t.ecosystem), "liquidity": part(t.liquidity), "team": part(t.team)]
        )
    }

    public struct Share: Equatable, Sendable {
        public var usd: Double
        public var veil: Double
        public var weight: Double
    }

    public static func memberShare(poolUsd: Double, myMinutes: Double, totalMinutes: Double, boost: Double, price: Double = refPrice) -> Share {
        if totalMinutes == 0 || myMinutes == 0 || price == 0 { return Share(usd: 0, veil: 0, weight: 0) }
        let weight = myMinutes / totalMinutes
        let usd = poolUsd * weight
        return Share(usd: usd, veil: (usd / price) * boost, weight: weight)
    }

    /// Epoch number shown in the interface. Day zero is 1 November 2026 UTC, matching `app.js`.
    public static func epochNumber(at date: Date = Date()) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = calendar.date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: 2026, month: 11, day: 1))!
        let days = date.timeIntervalSince(start) / 86_400
        return Int(floor(days)) + 1
    }

    public static func memberRange(index: Int) -> String {
        let tier = tiers[index]
        if index + 1 < tiers.count {
            let next = tiers[index + 1]
            return "\(VeilFormat.grouped(tier.minMembers)) – \(VeilFormat.grouped(next.minMembers - 1))"
        }
        return "\(VeilFormat.grouped(tier.minMembers))+"
    }
}
