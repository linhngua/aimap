import MapKit

final class LuxuryTapAnnotation: NSObject, MKAnnotation {
    static let fixedId = "tap_pin"

    dynamic var coordinate: CLLocationCoordinate2D

    init(coordinate: CLLocationCoordinate2D) {
        self.coordinate = coordinate
        super.init()
    }
}

