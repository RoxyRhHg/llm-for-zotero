import { assert } from "chai";
import { classifyWriteNoteDestination } from "../src/agent/writeNoteDestination";

describe("write note destination classifier", function () {
  it("treats Zotero library note requests as Zotero note workflows", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "save a standalone note into my Zotero library",
        "Obsidian",
      ),
      "zotero",
    );
    assert.equal(
      classifyWriteNoteDestination("create a reading note for this paper"),
      "zotero",
    );
  });

  it("treats explicit external destinations as file note workflows", function () {
    assert.equal(
      classifyWriteNoteDestination("write this figure note to my Obsidian"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination("save this as a markdown file"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination(
        "write this to Research Vault",
        "Research Vault",
      ),
      "file",
    );
  });

  it("does not turn ordinary paper requests into note destination rules", function () {
    assert.equal(classifyWriteNoteDestination("summarize this paper"), "none");
  });

  it("recognizes multilingual file destinations", function () {
    const fileRequests = [
      "把阅读笔记保存到文件夹",
      "写一篇阅读笔记保存为md文件",
      "ノートをファイルに保存してください",
      "노트를 파일로 저장해줘",
      "guardar la nota en un archivo",
      "enregistre la note dans un dossier",
      "speichere die Notiz als Datei",
      "сохранить заметку в файл",
    ];
    for (const text of fileRequests) {
      assert.equal(classifyWriteNoteDestination(text), "file", text);
    }
  });

  it("recognizes non-ASCII notes directory nicknames", function () {
    assert.equal(
      classifyWriteNoteDestination("把笔记写到 知识库 里", "知识库"),
      "file",
    );
  });

  it("keeps multilingual non-file requests out of the file route", function () {
    assert.equal(
      classifyWriteNoteDestination("总结这篇论文的主要发现"),
      "none",
    );
    assert.equal(classifyWriteNoteDestination("この論文を要約して"), "none");
  });

  it("does not treat a source PDF 文件 as a file destination", function () {
    // 文件 names the source PDF here — these are Zotero-note requests.
    assert.equal(
      classifyWriteNoteDestination("阅读这个PDF文件并保存一份笔记到Zotero"),
      "zotero",
    );
    assert.equal(
      classifyWriteNoteDestination("请根据这份PDF文件保存一条Zotero笔记"),
      "zotero",
    );
    assert.notEqual(
      classifyWriteNoteDestination("帮我写一份关于这个PDF文件的总结笔记"),
      "file",
    );
  });

  it("keeps plain-English requests off the multilingual file route", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "I exported the data to my local machine. Now write a Zotero note about this paper.",
      ),
      "zotero",
    );
    assert.equal(classifyWriteNoteDestination("Décris ce fichier"), "none");
  });
});
