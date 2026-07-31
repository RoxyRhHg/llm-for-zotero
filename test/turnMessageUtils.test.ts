import { assert } from "chai";
import {
  findTurnPairByTimestamps,
  cloneTurnMessageForUndo,
  collectAttachmentHashesFromMessages,
} from "../src/modules/contextPanel/turnMessageUtils";
import type { Message } from "../src/modules/contextPanel/types";

const HASH_A = "a".repeat(64);
const HASH_IMG = "b".repeat(64);

function message(role: "user" | "assistant", timestamp: number): Message {
  return { role, timestamp, text: `${role}@${timestamp}` } as Message;
}

describe("turnMessageUtils", function () {
  it("finds a user/assistant pair by floored timestamps", function () {
    const history = [
      message("user", 100),
      message("assistant", 200),
      message("user", 300),
      message("assistant", 400),
    ];
    const pair = findTurnPairByTimestamps(history, 300.7, 400.2);
    assert.isOk(pair);
    assert.equal(pair!.userIndex, 2);
    assert.equal(pair!.userMessage.timestamp, 300);
    assert.isNull(findTurnPairByTimestamps(history, 300, 999));
    assert.isNull(findTurnPairByTimestamps(history, 0, 400));
  });

  it("clone is deep for array fields", function () {
    const original = {
      role: "user",
      timestamp: 1,
      text: "hi",
      attachments: [{ contentHash: HASH_A, category: "file" }],
      selectedTexts: ["a"],
    } as unknown as Message;
    const clone = cloneTurnMessageForUndo(original);
    assert.notStrictEqual(clone.attachments, original.attachments);
    assert.notStrictEqual(clone.attachments![0], original.attachments![0]);
    assert.notStrictEqual(clone.selectedTexts, original.selectedTexts);
    assert.deepEqual(clone.attachments, original.attachments);
  });

  it("collects non-image attachment hashes uniquely", function () {
    const messages = [
      {
        role: "user",
        timestamp: 1,
        text: "",
        attachments: [
          { contentHash: HASH_A, category: "file" },
          { contentHash: HASH_A, category: "file" },
          { contentHash: HASH_IMG, category: "image" },
        ],
      },
    ] as unknown as Message[];
    const hashes = collectAttachmentHashesFromMessages(messages);
    assert.deepEqual(hashes, [HASH_A]);
  });
});
