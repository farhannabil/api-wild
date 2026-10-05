export function recognitionText(event) {
  let finalText = '', interimText = '';
  for (let index = event.resultIndex; index < event.results.length; index++) {
    const result = event.results[index], text = result[0]?.transcript;
    if (typeof text !== 'string') continue;
    if (result.isFinal) finalText += text + ' ';
    else interimText += text;
  }
  return {finalText: finalText.trim(), interimText};
}
export function recognitionError(code) {
  return ({'not-allowed':'Microphone access was not allowed. Use typing, or change your browser permission and try again.', 'service-not-allowed':'Your browser speech service is unavailable. Use typing instead.', 'audio-capture':'No microphone is available. Check your device and browser settings.', network:'The browser speech service could not connect. Try again or type your message.', 'no-speech':'No speech was detected. Try again or type your message.', 'language-not-supported':'This browser does not support recognition in the selected language.'})[code] || 'Dictation stopped. Type your message or try again.';
}
// One finite microphone session; cancelled/stale timer callbacks cannot stop a new session.
export function dictationDeadline(onExpire, scheduler = globalThis) {
  let active = true;
  const timer = scheduler.setTimeout(() => {if (!active) return; active = false; onExpire();}, 60000);
  return {cancel() {active = false; scheduler.clearTimeout(timer);}};
}
