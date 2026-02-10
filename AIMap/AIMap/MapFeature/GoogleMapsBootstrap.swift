import Foundation
import GoogleMaps

enum GoogleMapsBootstrap {
    static let apiKeyInfoPlistKey = "GOOGLE_MAPS_API_KEY"
    static let apiKeyEnvKey = "GOOGLE_MAPS_API_KEY"

    private static var didConfigure: Bool = false

    static func configureIfPossible() -> Bool {
        if didConfigure { return true }

        let fromPlist = (Bundle.main.object(forInfoDictionaryKey: apiKeyInfoPlistKey) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let fromEnv = ProcessInfo.processInfo.environment[apiKeyEnvKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let key = fromPlist.isEmpty ? fromEnv : fromPlist
        guard !key.isEmpty else { return false }

        GMSServices.provideAPIKey(key)
        didConfigure = true
        return true
    }

    static var isConfigured: Bool {
        didConfigure
    }
}

