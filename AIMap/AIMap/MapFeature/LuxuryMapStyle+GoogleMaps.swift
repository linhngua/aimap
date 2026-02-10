import GoogleMaps
import UIKit

extension LuxuryMapStyle {
    func apply(to mapView: GMSMapView) {
        mapView.isMyLocationEnabled = true
        mapView.settings.compassButton = false
        mapView.settings.rotateGestures = true
        mapView.settings.zoomGestures = true
        mapView.settings.scrollGestures = true
        mapView.settings.tiltGestures = false
        mapView.settings.allowScrollGesturesDuringRotateOrZoom = true

        mapView.backgroundColor = backgroundTone

        if let style = googleMapStyle() {
            mapView.mapStyle = style
        } else {
            mapView.mapStyle = nil
        }
    }

    func googleMapStyle() -> GMSMapStyle? {
        guard forceDarkAppearance else { return nil }

        // Dark, muted, minimal style intended to feel premium and reduce noise.
        let json = """
        [
          {"elementType":"geometry","stylers":[{"color":"#0D1117"}]},
          {"elementType":"labels.text.fill","stylers":[{"color":"#9AA4B2"}]},
          {"elementType":"labels.text.stroke","stylers":[{"color":"#0D1117"},{"weight":2}]},

          {"featureType":"poi","stylers":[{"visibility":"off"}]},
          {"featureType":"transit","stylers":[{"visibility":"off"}]},

          {"featureType":"road","elementType":"geometry","stylers":[{"color":"#1F2430"}]},
          {"featureType":"road.arterial","elementType":"geometry","stylers":[{"color":"#2A3140"}]},
          {"featureType":"road.highway","elementType":"geometry","stylers":[{"color":"#353D4F"}]},
          {"featureType":"road","elementType":"labels.text.fill","stylers":[{"color":"#7F8A99"}]},

          {"featureType":"water","elementType":"geometry","stylers":[{"color":"#0B1620"}]},
          {"featureType":"water","elementType":"labels.text.fill","stylers":[{"color":"#667184"}]},

          {"featureType":"administrative","elementType":"geometry","stylers":[{"color":"#1B2230"}]},
          {"featureType":"administrative","elementType":"labels.text.fill","stylers":[{"color":"#7F8A99"}]},

          {"featureType":"landscape.natural","elementType":"geometry","stylers":[{"color":"#0B1216"}]},
          {"featureType":"landscape.man_made","elementType":"geometry","stylers":[{"color":"#0D1117"}]}
        ]
        """

        return try? GMSMapStyle(jsonString: json)
    }
}

