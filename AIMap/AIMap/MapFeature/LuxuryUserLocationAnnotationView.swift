import MapKit
import UIKit

final class LuxuryUserLocationAnnotationView: MKAnnotationView {
    static let reuseIdentifier = "LuxuryUserLocationAnnotationView"

    var accentColor: UIColor = UIColor(red: 0.84, green: 0.76, blue: 0.55, alpha: 1) {
        didSet { updateColors() }
    }

    private let circleLayer = CAShapeLayer()
    private let imageView = UIImageView()

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
        transform = .identity
        layer.shadowOpacity = 0.22
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        circleLayer.frame = bounds
        circleLayer.path = UIBezierPath(ovalIn: bounds).cgPath
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        applyHighlight(selected, animated: animated)
    }

    private func commonInit() {
        frame = CGRect(x: 0, y: 0, width: 26, height: 26)
        centerOffset = .zero
        collisionMode = .circle
        canShowCallout = false
        displayPriority = .required

        circleLayer.fillColor = UIColor(white: 0.05, alpha: 0.78).cgColor
        circleLayer.strokeColor = accentColor.withAlphaComponent(0.65).cgColor
        circleLayer.lineWidth = max(1.0, 1.0 / UIScreen.main.scale)
        layer.addSublayer(circleLayer)

        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.tintColor = accentColor
        imageView.image = UIImage(systemName: "person.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        addSubview(imageView)

        NSLayoutConstraint.activate([
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            imageView.widthAnchor.constraint(equalToConstant: 13),
            imageView.heightAnchor.constraint(equalToConstant: 13),
        ])

        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.22
        layer.shadowRadius = 10
        layer.shadowOffset = CGSize(width: 0, height: 6)
    }

    private func updateColors() {
        circleLayer.strokeColor = accentColor.withAlphaComponent(0.65).cgColor
        imageView.tintColor = accentColor
    }

    private func applyHighlight(_ highlighted: Bool, animated: Bool) {
        let changes = {
            self.transform = highlighted ? CGAffineTransform(scaleX: 1.08, y: 1.08) : .identity
            self.layer.shadowOpacity = highlighted ? 0.34 : 0.22
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        } else {
            changes()
        }
    }
}

