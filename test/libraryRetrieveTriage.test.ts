import { assert } from "chai";
import { triageCandidatesWithModel } from "../src/agent/services/libraryRetrieveTriage";

describe("libraryRetrieveTriage", function () {
  it("returns null without model config or candidates", async function () {
    const noConfig = await triageCandidatesWithModel({
      query: "stimulation protocols",
      intent: "enumerate",
      candidates: [
        { itemId: "1", title: "Paper", abstract: "", matchedVia: "" },
      ],
      maxSelect: 5,
    });
    assert.isNull(noConfig);

    const noCandidates = await triageCandidatesWithModel({
      query: "stimulation protocols",
      intent: "enumerate",
      candidates: [],
      maxSelect: 5,
      apiBase: "https://example.invalid",
      apiKey: "key",
    });
    assert.isNull(noCandidates);
  });
});
