import Network
import SwiftUI
import UserNotifications
import VeilVPNKit

@main
struct VeilVPNApp: App {
    @State private var model = VeilModel()
    @State private var alerts = NetworkAlerts()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task {
                    await model.boot()
                    alerts.start(model)
                }
        }
        #if os(macOS)
        .defaultSize(width: 980, height: 760)
        #endif
    }
}

@MainActor
final class NetworkAlerts: NSObject, UNUserNotificationCenterDelegate {
    private let watch = NetworkWatch()
    private weak var model: VeilModel?

    func start(_ model: VeilModel) {
        guard !CommandLine.arguments.contains("-veil-ui-test") else { return }
        self.model = model
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let protect = UNNotificationAction(identifier: "protect", title: "Protect now", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: "veil.alert", actions: [protect], intentIdentifiers: [])])
        watch.start { [weak self] type in
            Task { @MainActor in self?.changed(type) }
        }
        if model.settings.alerts {
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    private func changed(_ type: String) {
        guard let model else { return }
        guard model.noteNetwork(type) else { return }
        let copy = VeilCopy.alert(risk: "none")
        let content = UNMutableNotificationContent()
        content.title = copy.title
        content.body = copy.body
        content.categoryIdentifier = "veil.alert"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "veil.wifi.\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == "protect" || response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        await self.protect()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    @MainActor
    private func protect() async {
        await model?.togglePower()
    }
}

final class NetworkWatch {
    private let monitor = NWPathMonitor()
    func start(_ onChange: @escaping (String) -> Void) {
        monitor.pathUpdateHandler = { path in
            let type: String
            if path.status != .satisfied { type = "none" }
            else if path.usesInterfaceType(.wifi) { type = "wifi" }
            else if path.usesInterfaceType(.cellular) { type = "cellular" }
            else if path.usesInterfaceType(.wiredEthernet) { type = "ethernet" }
            else { type = "other" }
            onChange(type)
        }
        monitor.start(queue: DispatchQueue(label: "veil.network"))
    }
}
