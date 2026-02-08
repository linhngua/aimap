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
    var dropPinCoordinate: CLLocationCoordinate2D?
    var onTap: (CLLocationCoordinate2D) -> Void
    var onSelectPin: (String) -> Void

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

        context.coordinator.render(pins: pins, dropPinCoordinate: dropPinCoordinate, on: mapView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(region: $region, style: style, onTap: onTap, onSelectPin: onSelectPin)
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

        private var pendingRemovals: Set<String> = []

        init(region: Binding<MKCoordinateRegion>, style: LuxuryMapStyle, onTap: @escaping (CLLocationCoordinate2D) -> Void, onSelectPin: @escaping (String) -> Void) {
            _region = region
            self.style = style
            self.onTap = onTap
            self.onSelectPin = onSelectPin
        }

        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let mapView = recognizer.view as? MKMapView else { return }
            if recognizer.state != .ended { return }

            let point = recognizer.location(in: mapView)
            if isTapOnAnnotationView(mapView.hitTest(point, with: nil)) { return }
            let coordinate = mapView.convert(point, toCoordinateFrom: mapView)
            onTap(coordinate)
        }

        func render(pins: [LuxuryMapPin], dropPinCoordinate: CLLocationCoordinate2D?, on mapView: MKMapView) {
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
            if annotation is MKUserLocation { return nil }
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
            guard let annotation = view.annotation as? LuxuryPlaceAnnotation else { return }
            onSelectPin(annotation.placeLocalId)
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
