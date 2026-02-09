import SwiftUI

struct SettingsView: View {
    @Binding var radiusMeters: Double
    @Binding var isCachePrimerEnabled: Bool

    var body: some View {
        Form {
            Section("AI Backend") {
                LabeledContent("Status", value: "Enabled")
                Text("Backend is embedded in the app.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Search") {
                Slider(value: $radiusMeters, in: 200...1500, step: 50) {
                    Text("Radius")
                } minimumValueLabel: {
                    Text("200m")
                        .font(.caption)
                } maximumValueLabel: {
                    Text("1500m")
                        .font(.caption)
                }

                Text("Radius: \(Int(radiusMeters)) meters")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Cache Primer") {
                Toggle("Prime cache in background", isOn: $isCachePrimerEnabled)
                Text("Warms nearby results around your current location while the app is open.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Notes") {
                Text("Manual refresh bypasses backend cache via header.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
