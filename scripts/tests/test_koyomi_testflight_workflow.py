import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "koyomi-testflight.yml"


class KoyomiTestFlightWorkflowTests(unittest.TestCase):
    def test_reusable_workflow_and_source_use_the_same_commit(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        implementation = re.search(
            r"uses: kandotrun/koyomi-ios/\.github/workflows/testflight\.yml@([0-9a-f]{40})",
            workflow,
        )
        source = re.search(r"source_ref: ([0-9a-f]{40})", workflow)

        if implementation is None:
            self.fail("Koyomi reusable workflow must use a full commit SHA")
        if source is None:
            self.fail("Koyomi source must use a full commit SHA")
        self.assertEqual(
            implementation.group(1),
            source.group(1),
            "Koyomi verifier and archived source are pinned to different commits",
        )


if __name__ == "__main__":
    unittest.main()
