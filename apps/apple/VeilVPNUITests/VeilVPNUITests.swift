import XCTest

final class VeilVPNUITests: XCTestCase {
    func testConnectLocationsAndSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["-veil-ui-test"]
        app.launch()

        let status = app.descendants(matching: .any)["status-word"]
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Not protected."].exists)
        XCTAssertTrue(app.descendants(matching: .any)["power"].exists)

        app.descendants(matching: .any)["nav-servers"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["locations-title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Choose a location."].exists)

        app.descendants(matching: .any)["nav-settings"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Kill switch"].exists)
        XCTAssertTrue(app.staticTexts["Block trackers"].exists)

        app.descendants(matching: .any)["nav-earn"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["earn-title"].waitForExistence(timeout: 5))

        app.descendants(matching: .any)["nav-connect"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Not protected."].exists)
    }
}
