import CoreGraphics
import MapKit

final class LuxuryPlaceAnnotation: NSObject, MKAnnotation {
    let placeLocalId: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var title: String?
    var opacity: CGFloat
    var isHighlighted: Bool

    init(placeLocalId: String, title: String, coordinate: CLLocationCoordinate2D, opacity: CGFloat, isHighlighted: Bool) {
        self.placeLocalId = placeLocalId
        self.coordinate = coordinate
        self.title = title
        self.opacity = opacity
        self.isHighlighted = isHighlighted
        super.init()
    }
}
