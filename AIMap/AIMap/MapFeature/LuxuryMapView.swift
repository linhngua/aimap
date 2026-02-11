import CoreLocation
import MapKit
import SwiftUI
import UIKit

struct LuxuryMapPin: Identifiable {
    let id: String
    let title: String
    let coordinate: CLLocationCoordinate2D
    let opacity: CGFloat
    let isHighlighted: Bool
}

struct LuxuryMapView: UIViewRepresentable {
    @Binding var region: MKCoordinateRegion

    var style: LuxuryMapStyle
    var pins: [LuxuryMapPin]
    var areaCellIds: [String]
    var dropPinCoordinate: CLLocationCoordinate2D?
    var onTap: (CLLocationCoordinate2D) -> Void
    var onSelectPin: (String) -> Void
    var onSelectUserLocation: (CLLocationCoordinate2D) -> Void

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView(frame: .zero)
        mapView.delegate = context.coordinator
        mapView.showsUserLocation = true
        mapView.pointOfInterestFilter = .excludingAll
        style.apply(to: mapView)
        mapView.setRegion(region, animated: false)

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        tap.cancelsTouchesInView = false
        mapView.addGestureRecognizer(tap)

        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.style = style
        style.apply(to: mapView)

        if shouldUpdateRegion(mapView.region, region) {
            mapView.setRegion(region, animated: true)
        }

        context.coordinator.render(pins: pins, dropPinCoordinate: dropPinCoordinate, areaCellIds: areaCellIds, on: mapView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(region: $region, style: style, onTap: onTap, onSelectPin: onSelectPin, onSelectUserLocation: onSelectUserLocation)
    }

    private func shouldUpdateRegion(_ current: MKCoordinateRegion, _ desired: MKCoordinateRegion) -> Bool {
        let delta = abs(current.center.latitude - desired.center.latitude) + abs(current.center.longitude - desired.center.longitude)
        if delta > 0.0005 { return true }
        let spanDelta = abs(current.span.latitudeDelta - desired.span.latitudeDelta) + abs(current.span.longitudeDelta - desired.span.longitudeDelta)
        return spanDelta > 0.0005
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        @Binding private var region: MKCoordinateRegion
        var style: LuxuryMapStyle
        private let onTap: (CLLocationCoordinate2D) -> Void
        private let onSelectPin: (String) -> Void
        private let onSelectUserLocation: (CLLocationCoordinate2D) -> Void

        private var pendingRemovals: Set<String> = []
        private var lastAreaCellIds: Set<String> = []

        init(
            region: Binding<MKCoordinateRegion>,
            style: LuxuryMapStyle,
            onTap: @escaping (CLLocationCoordinate2D) -> Void,
            onSelectPin: @escaping (String) -> Void,
            onSelectUserLocation: @escaping (CLLocationCoordinate2D) -> Void
        ) {
            _region = region
            self.style = style
            self.onTap = onTap
            self.onSelectPin = onSelectPin
            self.onSelectUserLocation = onSelectUserLocation
        }

        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let mapView = recognizer.view as? MKMapView else { return }
            if recognizer.state != .ended { return }

            let point = recognizer.location(in: mapView)
            if isTapOnAnnotationView(mapView.hitTest(point, with: nil)) { return }
            let coordinate = mapView.convert(point, toCoordinateFrom: mapView)
            onTap(coordinate)
        }

        func render(pins: [LuxuryMapPin], dropPinCoordinate: CLLocationCoordinate2D?, areaCellIds: [String], on mapView: MKMapView) {
            let desiredById = Dictionary(uniqueKeysWithValues: pins.map { ($0.id, $0) })

            let existing = mapView.annotations.compactMap { $0 as? LuxuryPlaceAnnotation }
            let existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.placeLocalId, $0) })

            let existingIds = Set(existingById.keys)
            let desiredIds = Set(desiredById.keys)

            let toAdd = desiredIds.subtracting(existingIds)
            let toRemove = existingIds.subtracting(desiredIds)
            let toUpdate = desiredIds.intersection(existingIds)

            for id in toUpdate {
                guard let model = desiredById[id], let annotation = existingById[id] else { continue }
                annotation.coordinate = model.coordinate
                annotation.title = model.title
                annotation.opacity = model.opacity
                annotation.isHighlighted = model.isHighlighted
                if let view = mapView.view(for: annotation) as? LuxuryPinAnnotationView {
                    view.accentColor = style.accentColor
                    view.applyState(opacity: model.opacity, isHighlighted: model.isHighlighted, animated: true)
                }
            }

            for id in toAdd {
                guard let model = desiredById[id] else { continue }
                let annotation = LuxuryPlaceAnnotation(
                    placeLocalId: model.id,
                    title: model.title,
                    coordinate: model.coordinate,
                    opacity: model.opacity,
                    isHighlighted: model.isHighlighted
                )
                mapView.addAnnotation(annotation)
            }

            for id in toRemove {
                guard let annotation = existingById[id] else { continue }
                removeAnnotation(annotation, from: mapView)
            }

            renderDropPin(coordinate: dropPinCoordinate, on: mapView)
            renderAreaOverlays(cellIds: areaCellIds, on: mapView)
        }

        private func removeAnnotation(_ annotation: LuxuryPlaceAnnotation, from mapView: MKMapView) {
            let id = annotation.placeLocalId
            if pendingRemovals.contains(id) { return }
            pendingRemovals.insert(id)

            if let view = mapView.view(for: annotation) {
                UIView.animate(
                    withDuration: 0.22,
                    delay: 0,
                    options: [.beginFromCurrentState, .allowUserInteraction],
                    animations: {
                        view.alpha = 0
                        view.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
                    },
                    completion: { [weak self] _ in
                        mapView.removeAnnotation(annotation)
                        self?.pendingRemovals.remove(id)
                    }
                )
            } else {
                mapView.removeAnnotation(annotation)
                pendingRemovals.remove(id)
            }
        }

        private func renderDropPin(coordinate: CLLocationCoordinate2D?, on mapView: MKMapView) {
            let existing = mapView.annotations.compactMap { $0 as? LuxuryTapAnnotation }.first

            guard let coordinate else {
                if let existing {
                    mapView.removeAnnotation(existing)
                }
                return
            }

            if let existing {
                existing.coordinate = coordinate
            } else {
                mapView.addAnnotation(LuxuryTapAnnotation(coordinate: coordinate))
            }
        }

        private func renderAreaOverlays(cellIds: [String], on mapView: MKMapView) {
            let desired = Set(cellIds.filter { !$0.isEmpty })
            if desired == lastAreaCellIds { return }
            lastAreaCellIds = desired

            let existingPolygons = mapView.overlays.compactMap { $0 as? MKPolygon }.filter {
                ($0.title ?? "").hasPrefix("aimap_cell:")
            }
            let existingByCell = Dictionary(uniqueKeysWithValues: existingPolygons.compactMap { polygon -> (String, MKPolygon)? in
                guard let title = polygon.title, title.hasPrefix("aimap_cell:") else { return nil }
                let cellId = String(title.dropFirst("aimap_cell:".count))
                guard !cellId.isEmpty else { return nil }
                return (cellId, polygon)
            })

            let existingIds = Set(existingByCell.keys)
            let toAdd = desired.subtracting(existingIds)
            let toRemove = existingIds.subtracting(desired)

            for cellId in toRemove {
                if let polygon = existingByCell[cellId] {
                    mapView.removeOverlay(polygon)
                }
            }

            for cellId in toAdd {
                guard let bounds = Geohash.decodeBounds(cellId) else { continue }
                var coords = [
                    CLLocationCoordinate2D(latitude: bounds.latMin, longitude: bounds.lngMin),
                    CLLocationCoordinate2D(latitude: bounds.latMax, longitude: bounds.lngMin),
                    CLLocationCoordinate2D(latitude: bounds.latMax, longitude: bounds.lngMax),
                    CLLocationCoordinate2D(latitude: bounds.latMin, longitude: bounds.lngMax),
                ]
                let polygon = MKPolygon(coordinates: &coords, count: coords.count)
                polygon.title = "aimap_cell:\(cellId)"
                mapView.addOverlay(polygon, level: .aboveRoads)
            }
        }

        private func isTapOnAnnotationView(_ view: UIView?) -> Bool {
            var current = view
            while let unwrapped = current {
                if unwrapped is MKAnnotationView { return true }
                current = unwrapped.superview
            }
            return false
        }

        // MARK: MKMapViewDelegate

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            region = mapView.region
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation {
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: LuxuryUserLocationAnnotationView.reuseIdentifier) as? LuxuryUserLocationAnnotationView)
                    ?? LuxuryUserLocationAnnotationView(annotation: annotation, reuseIdentifier: LuxuryUserLocationAnnotationView.reuseIdentifier)
                view.annotation = annotation
                view.accentColor = style.accentColor
                return view
            }
            if annotation is LuxuryTapAnnotation {
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: LuxuryTapAnnotationView.reuseIdentifier) as? LuxuryTapAnnotationView)
                    ?? LuxuryTapAnnotationView(annotation: annotation, reuseIdentifier: LuxuryTapAnnotationView.reuseIdentifier)
                view.annotation = annotation
                return view
            }
            guard let placeAnnotation = annotation as? LuxuryPlaceAnnotation else { return nil }

            let view = (mapView.dequeueReusableAnnotationView(withIdentifier: LuxuryPinAnnotationView.reuseIdentifier) as? LuxuryPinAnnotationView)
                ?? LuxuryPinAnnotationView(annotation: placeAnnotation, reuseIdentifier: LuxuryPinAnnotationView.reuseIdentifier)

            view.annotation = placeAnnotation
            view.accentColor = style.accentColor
            view.applyState(opacity: placeAnnotation.opacity, isHighlighted: placeAnnotation.isHighlighted, animated: false)
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            if let userLocation = view.annotation as? MKUserLocation, let coordinate = userLocation.location?.coordinate {
                onSelectUserLocation(coordinate)
                mapView.deselectAnnotation(userLocation, animated: false)
                return
            }

            guard let annotation = view.annotation as? LuxuryPlaceAnnotation else { return }
            onSelectPin(annotation.placeLocalId)
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let polygon = overlay as? MKPolygon else { return MKOverlayRenderer(overlay: overlay) }
            guard let title = polygon.title, title.hasPrefix("aimap_cell:") else { return MKOverlayRenderer(overlay: overlay) }

            let renderer = MKPolygonRenderer(polygon: polygon)
            renderer.fillColor = UIColor(white: 0.95, alpha: 0.08)
            renderer.strokeColor = UIColor(white: 0.95, alpha: 0.16)
            renderer.lineWidth = max(0.5, 1.0 / UIScreen.main.scale)
            return renderer
        }

        func mapView(_ mapView: MKMapView, didAdd views: [MKAnnotationView]) {
            for view in views {
                guard view.annotation is LuxuryPlaceAnnotation || view.annotation is LuxuryTapAnnotation else { continue }
                let targetAlpha = view.alpha
                view.alpha = 0
                view.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
                UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                    view.alpha = targetAlpha
                    view.transform = .identity
                }
            }
        }
    }
}
