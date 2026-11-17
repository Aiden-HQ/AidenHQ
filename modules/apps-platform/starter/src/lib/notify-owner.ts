// The app's agent hears about people's input at once: call notifyOwner() after the server has stored a submission
// (feedback, a request, a correction in the app's own store). On a shared app whose registry entry sets `feedback_to`, the
// gate wakes that agent ("App feedback: <app>"), which reads the new items from the app's agent API. Only the fact travels:
// never send the text here. Off the platform the path doesn't exist and this does nothing.
export function notifyOwner(): void {
  void fetch("/.aidenhq/notify", { method: "POST" }).catch(() => {})
}
