import CoreLocation
import GoogleMaps
import MapKit
import SwiftUI
import UIKit

struct GoogleLuxuryMapView: UIViewRepresentable {
    @Binding var region: MKCoordinateRegion

    var style: LuxuryMapStyle
    var pins: [LuxuryMapPin]
    var dropPinCoordinate: CLLocationCoordinate2D?
    var onTap: (CLLocationCoordinate2D) -> Void
    var onSelectPin: (String) -> Void

    func makeUIView(context: Context) -> GMSMapView {
        let camera = GMSCameraPosition(target: region.center, zoom: 14)
        let mapView = GMSMapView(frame: .zero, camera: camera)
        mapView.delegate = context.coordinator
        mapView.setMinZoom(4, maxZoom: 20)
        style.apply(to: mapView)
        return mapView
    }

    func updateUIView(_ mapView: GMSMapView, context: Context) {
        context.coordinator.style = style
        style.apply(to: mapView)

        if context.coordinator.shouldUpdateCamera(to: region, on: mapView) {
            context.coordinator.apply(region: region, to: mapView, animated: true)
        }

        context.coordinator.render(pins: pins, dropPinCoordinate: dropPinCoordinate, on: mapView)
        context.coordinator.highlightSelected(pins: pins, on: mapView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(region: $region, style: style, onTap: onTap, onSelectPin: onSelectPin)
    }

    final class Coordinator: NSObject, GMSMapViewDelegate {
        @Binding private var region: MKCoordinateRegion
        var style: LuxuryMapStyle
        private let onTap: (CLLocationCoordinate2D) -> Void
        private let onSelectPin: (String) -> Void

        private var markersById: [String: GMSMarker] = [:]
        private var tapMarker: GMSMarker?
        private var isProgrammaticCameraChange: Bool = false

        private let tapMarkerIcon: UIImage? = {
            let config = UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold)
            let image = UIImage(systemName: "mappin.and.ellipse", withConfiguration: config)
            return image?.withTintColor(UIColor(red: 0.82, green: 0.27, blue: 0.27, alpha: 1), renderingMode: .alwaysOriginal)
        }()

        init(
            region: Binding<MKCoordinateRegion>,
            style: LuxuryMapStyle,
            onTap: @escaping (CLLocationCoordinate2D) -> Void,
            onSelectPin: @escaping (String) -> Void
        ) {
            _region = region
            self.style = style
            self.onTap = onTap
            self.onSelectPin = onSelectPin
        }

        // MARK: Camera / region syncing

        func shouldUpdateCamera(to desired: MKCoordinateRegion, on mapView: GMSMapView) -> Bool {
            let current = mapView.camera.target
            let delta = abs(current.latitude - desired.center.latitude) + abs(current.longitude - desired.center.longitude)
            if delta > 0.0005 { return true }

            // Rough zoom heuristic from span; avoids fights while user is interacting.
            let desiredZoom = Self.zoomApprox(for: desired.span)
            let zoomDelta = abs(mapView.camera.zoom - desiredZoom)
            return zoomDelta > 0.8
        }

        func apply(region: MKCoordinateRegion, to mapView: GMSMapView, animated: Bool) {
            let zoom = Self.zoomApprox(for: region.span)
            let camera = GMSCameraPosition(target: region.center, zoom: zoom)
            isProgrammaticCameraChange = true
            if animated {
                mapView.animate(to: camera)
            } else {
                mapView.camera = camera
            }
        }

        static func zoomApprox(for span: MKCoordinateSpan) -> Float {
            // Approx conversion; tuned for city-level usage.
            let latDelta = max(0.0005, span.latitudeDelta)
            let zoom = log2(360.0 / latDelta)
            return Float(max(4.0, min(19.0, zoom)))
        }

        func mapView(_ mapView: GMSMapView, idleAt position: GMSCameraPosition) {
            if isProgrammaticCameraChange {
                isProgrammaticCameraChange = false
                return
            }
            updateRegionBinding(from: mapView)
        }

        private func updateRegionBinding(from mapView: GMSMapView) {
            let visible = mapView.projection.visibleRegion()
            let lats = [visible.farLeft.latitude, visible.farRight.latitude, visible.nearLeft.latitude, visible.nearRight.latitude]
            let lngs = [visible.farLeft.longitude, visible.farRight.longitude, visible.nearLeft.longitude, visible.nearRight.longitude]

            guard let minLat = lats.min(), let maxLat = lats.max(), let minLng = lngs.min(), let maxLng = lngs.max() else { return }

            let span = MKCoordinateSpan(latitudeDelta: max(0.0005, maxLat - minLat), longitudeDelta: max(0.0005, maxLng - minLng))
            region = MKCoordinateRegion(center: mapView.camera.target, span: span)
        }

        // MARK: Tap handling

        func mapView(_ mapView: GMSMapView, didTapAt coordinate: CLLocationCoordinate2D) {
            onTap(coordinate)
        }

        func mapView(_ mapView: GMSMapView, didTap marker: GMSMarker) -> Bool {
            if let id = marker.userData as? String {
                onSelectPin(id)
            }
            return true
        }

        // MARK: Pins / markers

        func render(pins: [LuxuryMapPin], dropPinCoordinate: CLLocationCoordinate2D?, on mapView: GMSMapView) {
            let desiredById = Dictionary(uniqueKeysWithValues: pins.map { ($0.id, $0) })
            let desiredIds = Set(desiredById.keys)
            let existingIds = Set(markersById.keys)

            let toAdd = desiredIds.subtracting(existingIds)
            let toRemove = existingIds.subtracting(desiredIds)
            let toUpdate = desiredIds.intersection(existingIds)

            for id in toUpdate {
                guard let model = desiredById[id], let marker = markersById[id] else { continue }
                marker.position = model.coordinate
                marker.title = model.title
                marker.opacity = Float(model.opacity)
                if let view = marker.iconView as? LuxuryGoogleMarkerView {
                    view.accentColor = style.accentColor
                    view.applyState(opacity: model.opacity, isHighlighted: model.isHighlighted, animated: true)
                }
            }

            for id in toAdd {
                guard let model = desiredById[id] else { continue }
                let marker = GMSMarker(position: model.coordinate)
                marker.title = model.title
                marker.userData = model.id
                marker.groundAnchor = CGPoint(x: 0.5, y: 0.5)
                marker.opacity = 0

                let iconView = LuxuryGoogleMarkerView(accentColor: style.accentColor)
                iconView.applyState(opacity: model.opacity, isHighlighted: model.isHighlighted, animated: false)
                marker.iconView = iconView
                marker.map = mapView

                markersById[id] = marker

                CATransaction.begin()
                CATransaction.setAnimationDuration(0.22)
                marker.opacity = Float(model.opacity)
                CATransaction.commit()
            }

            for id in toRemove {
                guard let marker = markersById[id] else { continue }
                markersById.removeValue(forKey: id)
                CATransaction.begin()
                CATransaction.setAnimationDuration(0.22)
                CATransaction.setCompletionBlock {
                    marker.map = nil
                }
                marker.opacity = 0
                CATransaction.commit()
            }

            renderDropPin(coordinate: dropPinCoordinate, on: mapView)
        }

        func highlightSelected(pins: [LuxuryMapPin], on mapView: GMSMapView) {
            // Ensure highlighted marker draws above others.
            guard let highlighted = pins.first(where: { $0.isHighlighted }) else { return }
            if let marker = markersById[highlighted.id] {
                marker.zIndex = 10
            }
            for pin in pins where !pin.isHighlighted {
                markersById[pin.id]?.zIndex = 1
            }
            tapMarker?.zIndex = 0
        }

        private func renderDropPin(coordinate: CLLocationCoordinate2D?, on mapView: GMSMapView) {
            guard let coordinate else {
                tapMarker?.map = nil
                tapMarker = nil
                return
            }

            if tapMarker == nil {
                let marker = GMSMarker(position: coordinate)
                marker.groundAnchor = CGPoint(x: 0.5, y: 1.0)
                marker.icon = tapMarkerIcon
                marker.opacity = 1
                marker.isTappable = false
                marker.map = mapView
                tapMarker = marker
            } else {
                tapMarker?.position = coordinate
            }
        }
    }
}

private final class LuxuryGoogleMarkerView: UIView {
    var accentColor: UIColor {
        didSet { updateColors() }
    }

    private let dotLayer = CAShapeLayer()

    init(accentColor: UIColor) {
        self.accentColor = accentColor
        super.init(frame: CGRect(x: 0, y: 0, width: 14, height: 14))
        isOpaque = false
        layer.addSublayer(dotLayer)
        dotLayer.shadowColor = UIColor.black.cgColor
        dotLayer.shadowOpacity = 0.12
        dotLayer.shadowRadius = 6
        dotLayer.shadowOffset = CGSize(width: 0, height: 4)

        layer.shadowColor = accentColor.cgColor
        layer.shadowOffset = .zero
        layer.shadowRadius = 10
        layer.shadowOpacity = 0
        updateColors()
        layoutDot()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutDot()
    }

    func applyState(opacity: CGFloat, isHighlighted: Bool, animated: Bool) {
        let changes = {
            self.alpha = opacity
            self.transform = isHighlighted ? CGAffineTransform(scaleX: 1.22, y: 1.22) : .identity
            self.layer.shadowOpacity = isHighlighted ? 0.35 : 0
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        } else {
            changes()
        }
    }

    private func updateColors() {
        dotLayer.fillColor = accentColor.cgColor
        layer.shadowColor = accentColor.cgColor
    }

    private func layoutDot() {
        dotLayer.frame = bounds
        dotLayer.path = UIBezierPath(ovalIn: bounds).cgPath
    }
}
