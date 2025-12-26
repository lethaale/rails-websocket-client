import { Controller } from "@hotwired/stimulus"

// Keeps the table scrolled to the newest (last) row when streaming appends arrive.
export default class extends Controller {
  static targets = ["content", "viewport"]

  connect() {
    document.addEventListener("turbo:before-stream-render", this.handleBeforeStreamRender)
    this.scrollToBottom()
  }

  disconnect() {
    document.removeEventListener("turbo:before-stream-render", this.handleBeforeStreamRender)
  }

  handleBeforeStreamRender = (event) => {
    const stream = event.detail?.newStream
    if (!stream) return

    const action = stream.getAttribute("action") || "append"
    const target = stream.getAttribute("target")

    if (action === "append" && target === this.contentTarget.id) {
      const render = event.detail.render
      event.detail.render = (streamElement) => {
        render(streamElement)
        this.scrollToBottom()
      }
    }
  }

  scrollToBottom() {
    const element = this.viewportTarget || this.contentTarget
    if (!element) return
    element.scrollTop = element.scrollHeight
  }
}

