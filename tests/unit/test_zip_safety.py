import io
import unittest
from zipfile import ZIP_STORED, ZipInfo

from pathlib import Path
import sys


SCRIPT_DIR = Path("skills/visual-first-ppt/scripts").resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.zip_safety import validate_zip_archive  # noqa: E402


class FakeArchive:
    def __init__(self, infos, compressed_size=1024):
        self._infos = infos
        self.fp = io.BytesIO(b"x" * compressed_size)

    def infolist(self):
        return self._infos


def stored_info(name, size):
    info = ZipInfo(name)
    info.compress_type = ZIP_STORED
    info.file_size = size
    info.compress_size = size
    return info


class ZipSafetyPolicyTest(unittest.TestCase):
    def test_total_limit_is_independent_of_the_larger_opaque_member_limit(self):
        archive = FakeArchive([
            stored_info("ppt/media/video-1.mp4", 45 * 1024 * 1024),
            stored_info("ppt/media/video-2.mp4", 45 * 1024 * 1024),
            stored_info("ppt/media/video-3.mp4", 45 * 1024 * 1024),
        ])
        with self.assertRaisesRegex(ValueError, r"total.*uncompressed|total.*output|ZIP.*total"):
            validate_zip_archive(archive, "PPTX")


if __name__ == "__main__":
    unittest.main()
