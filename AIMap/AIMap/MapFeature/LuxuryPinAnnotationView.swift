import MapKit
import UIKit

final class LuxuryPinAnnotationView: MKAnnotationView {
    static let reuseIdentifier = "LuxuryPinAnnotationView"

    var accentColor: UIColor = UIColor(red: 0.84, green: 0.76, blue: 0.55, alpha: 1) {
        didSet { updateColors() }
    }

    private let dotLayer = CAShapeLayer()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        commonInit()
        configure(with: annotation)
    }

    required init?(coder aDecoder: NSCoder) {
        super.init(coder: aDecoder)
        commonInit()
        configure(with: annotation)
    }

    override var annotation: MKAnnotation? {
        didSet { configure(with: annotation) }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        transform = .identity
        alpha = 1
        layer.shadowOpacity = 0
        layer.shadowRadius = 0
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        dotLayer.frame = bounds
        dotLayer.path = UIBezierPath(ovalIn: bounds).cgPath
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        applyHighlight(selected, animated: animated)
    }

    func applyState(opacity: CGFloat, isHighlighted: Bool, animated: Bool) {
        let changes = {
            self.alpha = opacity
            self.applyHighlight(isHighlighted, animated: false)
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        } else {
            changes()
        }
    }

    private func commonInit() {
        frame = CGRect(x: 0, y: 0, width: 14, height: 14)
        centerOffset = CGPoint(x: 0, y: -7)
        collisionMode = .circle
        canShowCallout = false

        dotLayer.fillColor = accentColor.cgColor
        dotLayer.shadowColor = UIColor.black.cgColor
        dotLayer.shadowOpacity = 0.12
        dotLayer.shadowRadius = 6
        dotLayer.shadowOffset = CGSize(width: 0, height: 4)
        layer.addSublayer(dotLayer)

        layer.shadowColor = accentColor.cgColor
        layer.shadowOffset = .zero
        layer.shadowRadius = 10
        layer.shadowOpacity = 0
    }

    private func updateColors() {
        dotLayer.fillColor = accentColor.cgColor
        layer.shadowColor = accentColor.cgColor
    }

    private func configure(with annotation: MKAnnotation?) {
        guard let annotation = annotation as? LuxuryPlaceAnnotation else { return }
        applyState(opacity: annotation.opacity, isHighlighted: annotation.isHighlighted, animated: false)
    }

    private func applyHighlight(_ highlighted: Bool, animated: Bool) {
        let changes = {
            self.transform = highlighted ? CGAffineTransform(scaleX: 1.22, y: 1.22) : .identity
            self.layer.shadowOpacity = highlighted ? 0.35 : 0
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        } else {
            changes()
        }
    }
}

