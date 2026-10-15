import AppKit
import SwiftUI

/// One native text surface: selection and Cmd-A/C work across all utterances.
struct SelectableTranscriptView: NSViewRepresentable {
    let text: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let view = NSTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = false
        view.drawsBackground = false
        view.font = .systemFont(ofSize: 17)
        view.textColor = .labelColor
        view.textContainerInset = NSSize(width: 22, height: 22)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.setAccessibilityLabel("Полная расшифровка")
        view.delegate = context.coordinator
        scroll.documentView = view
        context.coordinator.view = view
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.pending = text
        context.coordinator.refresh()
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        weak var view: NSTextView?
        var pending = ""
        private var updating = false
        func refresh() {
            guard !updating, let view, view.string != pending else { return }
            updating = true
            defer { updating = false }
            let selection = view.selectedRanges.map(\.rangeValue)
            let selecting = selection.contains { $0.length > 0 }
            let visible = view.visibleRect
            let follow = !selecting && (view.string.isEmpty || visible.maxY >= view.bounds.maxY - 50)
            let origin = view.enclosingScrollView?.contentView.bounds.origin
            view.string = pending
            let length = (pending as NSString).length
            view.selectedRanges = selection.map { range in
                let start = min(range.location, length)
                return NSValue(range: NSRange(location: start, length: min(range.length, length - start)))
            }
            if follow { view.scrollToEndOfDocument(nil) }
            else if let origin { view.enclosingScrollView?.contentView.scroll(to: origin) }
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            // Selection must not prevent new transcript fragments from appearing.
            refresh()
        }
    }
}
