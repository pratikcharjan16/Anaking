"""
Voice answering for Rating Scale questions with n fields:
- Parsers handle row numbers ("row 1 4, row 2 5"), ordinals ("first row 4"),
  multiple sequential ratings ("4 and 5", "4, 5, 3"), row labels ("Ease of use 5"),
  and auto-advancement across fields.
"""

import subprocess
import json


def test_rating_scale_voice_parser_via_node():
    script = """
    global.window = {};
    require('./static/js/voice.js');
    const B = global.window.BeaconVoice;
    const ctx = {
      type: "rating_scale",
      inputType: "number",
      activeFieldIndex: 0,
      fieldsCount: 3,
      rows: [
        { code: "a", label: "Ease of use" },
        { code: "b", label: "Reliability" },
        { code: "c", label: "Trust" }
      ],
      scale: { min: 1, max: 5 }
    };

    const results = {};

    // 1. Single rating with auto-advance
    results.single = B.parseCommand("4", ctx);
    results.word = B.parseCommand("five", ctx);

    // 2. Explicit row assignment
    results.explicitRows = B.parseCommand("row 1 four, row 2 five", ctx);
    results.explicitWithIs = B.parseCommand("row 1 is 4 and row 2 is 5", ctx);
    results.ordinalRows = B.parseCommand("first row 4, second row 5", ctx);

    // 3. Row label matching
    results.labelMatch = B.parseCommand("Ease of use 5", ctx);

    // 4. Sequential ratings in one breath
    results.joinedAnd = B.parseCommand("4 and 5", ctx);
    results.commaList = B.parseCommand("4, 5, 3", ctx);

    // 5. Row navigation
    results.rowNav = B.parseCommand("row 2", ctx);
    results.nextNav = B.parseCommand("next", ctx);

    console.log(JSON.stringify(results));
    """
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    data = json.loads(res.stdout)

    # 1. Single rating
    assert data["single"][0]["act"] == "fieldValue"
    assert data["single"][0]["value"] == 4
    assert data["single"][0]["autoAdvance"] is True
    assert data["word"][0]["value"] == 5

    # 2. Explicit rows
    assert len(data["explicitRows"]) == 2
    assert data["explicitRows"][0] == {"act": "fieldValue", "index": 0, "value": 4}
    assert data["explicitRows"][1] == {"act": "fieldValue", "index": 1, "value": 5}
    assert len(data["explicitWithIs"]) == 2
    assert data["explicitWithIs"][0]["value"] == 4
    assert data["ordinalRows"][0]["index"] == 0

    # 3. Label matching
    assert len(data["labelMatch"]) == 1
    assert data["labelMatch"][0] == {"act": "fieldValue", "index": 0, "value": 5}

    # 4. Sequential ratings
    assert len(data["joinedAnd"]) == 2
    assert data["joinedAnd"][0]["value"] == 4
    assert data["joinedAnd"][1]["value"] == 5
    assert len(data["commaList"]) == 3
    assert [x["value"] for x in data["commaList"]] == [4, 5, 3]

    # 5. Row navigation
    assert data["rowNav"][0] == {"act": "fieldSelect", "index": 1}
    assert data["nextNav"][0] == {"act": "next"}
