// Voice notes: Telegram file -> the local Whisper service (whisper-asr-webservice, faster-whisper) -> text.
// Audio never leaves the VM.
export async function transcribe(telegramToken: string, whisperUrl: string, fileId: string): Promise<string> {
  const tg = `https://api.telegram.org`;
  const file = (await (await fetch(`${tg}/bot${telegramToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15_000) })).json()) as any;
  if (!file?.ok) throw new Error("getFile failed");
  const audio = await (await fetch(`${tg}/file/bot${telegramToken}/${file.result.file_path}`, { signal: AbortSignal.timeout(60_000) })).blob();
  const form = new FormData();
  form.append("audio_file", audio, "voice.ogg");
  const res = await fetch(new URL("/asr?encode=true&task=transcribe&output=json", whisperUrl), { method: "POST", body: form, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`whisper ${res.status}`);
  return String(((await res.json()) as any).text ?? "").trim();
}
