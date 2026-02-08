import MapKit
import UIKit

final class LuxuryTapAnnotationView: MKAnnotationView {
    static let reuseIdentifier = "LuxuryTapAnnotationView"

    var pinColor: UIColor = UIColor(red: 0.82, green: 0.27, blue: 0.27, alpha: 1) {
        didSet { tintColor = pinColor }
    }

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        commonInit()
    }

    required init?(coder aDecoder: NSCoder) {
        super.init(coder: aDecoder)
        commonInit()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        alpha = 1
        transform = .identity
    }

    private func commonInit() {
        canShowCallout = false
        collisionMode = .rectangle
        displayPriority = .required

        let config = UIImage.SymbolConfiguration(pointSize: 26, weight: .semibold)
        image = UIImage(systemName: "mappin.and.ellipse", withConfiguration: config)
        tintColor = pinColor

        if let size = image?.size {
            frame = CGRect(origin: .zero, size: size)
            centerOffset = CGPoint(x: 0, y: -size.height / 2)
        } else {
            frame = CGRect(x: 0, y: 0, width: 30, height: 30)
            centerOffset = CGPoint(x: 0, y: -15)
        }
    }
}

