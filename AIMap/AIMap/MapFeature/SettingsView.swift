import SwiftUI

struct SettingsView: View {
    @Binding var radiusMeters: Double

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

            Section("Notes") {
                Text("Manual refresh bypasses backend cache via header.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
