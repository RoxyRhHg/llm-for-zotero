export type WriteNoteDestination = "none" | "zotero" | "file";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesConfiguredNickname(text: string, nickname?: string): boolean {
  const trimmed = (nickname || "").trim();
  if (!trimmed) return false;
  const escaped = escapeRegex(trimmed);
  const isAscii = /^[\x20-\x7E]+$/.test(trimmed);
  const pattern = isAscii
    ? new RegExp(`\\b${escaped}\\b`, "i")
    : new RegExp(escaped, "i");
  return pattern.test(text);
}

function hasPathLikeDestination(text: string): boolean {
  return /(?:^|\s)(?:~\/|\.{1,2}\/|\/[^\s]+|[A-Za-z]:[\\/]|[^\s]+\.md\b)/i.test(
    text,
  );
}

function hasFileDestinationSignal(
  text: string,
  notesDirectoryNickname?: string,
): boolean {
  if (matchesConfiguredNickname(text, notesDirectoryNickname)) return true;
  if (/\b(obsidian|vault)\b/i.test(text)) return true;
  if (/\b(?:markdown|md)\s+files?\b/i.test(text)) return true;
  // "md 文件" / "markdown ファイル" style phrasings.
  if (
    /(?:markdown|md)\s*(?:文件|文档|檔案|ファイル|파일|файл\p{L}*)/iu.test(text)
  ) {
    return true;
  }
  if (hasPathLikeDestination(text)) return true;
  // CJK save-to-file/folder phrasings. A file noun alone is NOT a signal
  // (文件 usually names the source PDF); the destination reading needs a
  // save verb joined to the noun by a directional marker (保存到文件夹,
  // 保存为md文件, ファイルに保存, 파일로 저장) or a compound write-into verb
  // (写入文件). Verb→noun and noun→verb orders are both covered.
  if (
    /(?:保存|存|导出|導出|输出|輸出|エクスポート|書き出し?|저장|내보내\p{L}*)[^\n。]{0,10}?(?:到|至|为|為|成|として)[^\n。]{0,10}(?:文件夹|文件|文檔|檔案|目录|目錄)|(?:写入|寫入|存入|存进|存進)[^\n。]{0,6}(?:文件|文件夹|文檔|檔案|目录|目錄)|(?:文件夹|文件|目录|目錄|ファイル|フォルダ|파일|폴더)(?:に|へ|として|里|中|에|로|으로)[^\n。]{0,10}(?:保存|書き出|出力|エクスポート|导出|導出|写入|寫入|存|저장|내보내)/u.test(
      text,
    )
  ) {
    return true;
  }
  // European-language save-to-file/folder phrasings, stem-based to cover
  // conjugations (guardar/guarda, speichern/speichere, enregistrer/enregistre…).
  // `\b` is ASCII-only in JS, so word-initial accented (écri…) and Cyrillic
  // stems use a `(?<!\p{L})` lookbehind instead of `\b` (décrire must not
  // match). The noun list is non-English on purpose — pairing these verbs
  // with English nouns ("local", "disk") regressed plain-English requests —
  // and finite export forms exclude English "exported".
  if (
    /(?:\b(?:guarda\p{L}*|export(?:ar|er|e|en|ez|ieren)|salva(?!guard)\p{L}*|enregistr\p{L}*|ecri\p{L}*|speicher\p{L}*|schreib\p{L}*)\b|(?<!\p{L})écri\p{L}*|(?<!\p{L})(?:сохран|экспорт|запис|запиш)\p{L}*)[^\n]{0,60}(?:\b(?:archivo|carpeta|fichier|dossier|datei|ordner)\b|(?<!\p{L})(?:файл|папк)\p{L}*)/iu.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(?:save|write|export|send|put|create|make)\b[\s\S]{0,120}\b(?:to|into|as|in|under)\b[\s\S]{0,120}\b(?:files?|folders?|directories|directory|disk|local)\b/i.test(
    text,
  );
}

function hasZoteroDestinationSignal(text: string): boolean {
  return /\b(?:zotero(?:\s+library|\s+note)?|standalone\s+notes?|item\s+notes?|child\s+notes?|current\s+(?:zotero\s+)?notes?|active\s+(?:zotero\s+)?notes?|open\s+(?:zotero\s+)?notes?)\b/i.test(
    text,
  );
}

function hasGenericNoteWriteSignal(text: string): boolean {
  return (
    /\b(?:create|make|write|draft|generate|save|append|add|put|edit|update|modify|rewrite|revise|polish)\b[\s\S]{0,120}\b(?:notes?|summary\s+notes?|reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b/i.test(
      text,
    ) ||
    /\b(?:notes?|summary\s+notes?|reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b[\s\S]{0,120}\b(?:save|write|append|add|create|make|edit|update|modify|rewrite|revise|polish)\b/i.test(
      text,
    ) ||
    /\b(?:reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b/i.test(
      text,
    ) ||
    /\b(?:summari[sz]e)\b[\s\S]{0,120}\b(?:into|as|to)\b[\s\S]{0,120}\bnotes?\b/i.test(
      text,
    )
  );
}

export function classifyWriteNoteDestination(
  userText: string | undefined,
  notesDirectoryNickname?: string,
): WriteNoteDestination {
  const text = (userText || "").trim();
  if (!text) return "none";
  if (hasFileDestinationSignal(text, notesDirectoryNickname)) return "file";
  if (hasZoteroDestinationSignal(text)) return "zotero";
  if (hasGenericNoteWriteSignal(text)) return "zotero";
  return "none";
}
