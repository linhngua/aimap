import MapKit
import SwiftUI
import UIKit

struct LuxuryMapStyle: Equatable {
    enum LabelDensity: String, CaseIterable {
        case standard
        case low
    }

    var backgroundTone: UIColor
    var accentColor: UIColor
    var labelDensity: LabelDensity
    var forceDarkAppearance: Bool
    var showsApplePointsOfInterest: Bool
    var showsTraffic: Bool
    var showsBuildings: Bool

    static let premium = LuxuryMapStyle(
        backgroundTone: UIColor(red: 0.05, green: 0.07, blue: 0.10, alpha: 1),
        accentColor: UIColor(red: 0.84, green: 0.76, blue: 0.55, alpha: 1),
        labelDensity: .low,
        forceDarkAppearance: true,
        showsApplePointsOfInterest: false,
        showsTraffic: false,
        showsBuildings: true
    )

    func makeConfiguration() -> MKStandardMapConfiguration {
        let configuration = MKStandardMapConfiguration()
        configuration.elevationStyle = .realistic
        configuration.emphasisStyle = labelDensity == .low ? .muted : .default
        configuration.showsTraffic = showsTraffic
        configuration.pointOfInterestFilter = showsApplePointsOfInterest ? .includingAll : .excludingAll
        return configuration
    }

    func apply(to mapView: MKMapView) {
        mapView.preferredConfiguration = makeConfiguration()
        mapView.backgroundColor = backgroundTone
        mapView.tintColor = accentColor

        if forceDarkAppearance {
            mapView.overrideUserInterfaceStyle = .dark
        } else {
            mapView.overrideUserInterfaceStyle = .unspecified
        }

        mapView.showsBuildings = showsBuildings
        mapView.showsScale = false
        mapView.showsCompass = false
        mapView.isPitchEnabled = false
        mapView.isRotateEnabled = true
        mapView.isZoomEnabled = true
        mapView.isScrollEnabled = true
    }
}
