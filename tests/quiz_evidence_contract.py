"""퀴즈 근거 전용 API와 상식퀴즈봇 사이의 구조화 계약 회귀 테스트.

실제 검색/Gemini를 호출하지 않는다. 서버가 유효한 구조화 응답을 반환했을 때
일반명사·과학·의학·대중문화 토픽이 클라이언트 단계에서 임의 차단되지 않는지,
반대로 출처/URL/정답 계약 위반은 fail-closed 되는지를 Python으로 미러링한다.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")
MATERIAL_ID_RE = re.compile(r"^M[1-9][0-9]*$")
GENERATED_MARKUP_RE = re.compile(
    r"https?://|www\.|\[[^\]]+\]\s*\(|</?[A-Za-z][^>]*>", re.I
)


def normalize_key(value: object) -> str:
    return re.sub(r"\s+", "", str(value).strip().lower())


def validate_structured_response(
    payload: dict[str, object], *, required_distractor_count: int = 4
) -> dict[str, object]:
    """lib/quiz-evidence.js validateSuccess의 핵심 계약을 미러링한다."""

    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ValueError("NO_SOURCES")
    sources: list[dict[str, str]] = []
    source_ids: set[str] = set()
    for raw in raw_sources[:5]:
        assert isinstance(raw, dict)
        source_id = str(raw.get("id", "")).strip()
        title = str(raw.get("title", "")).strip()
        url = str(raw.get("url", "")).strip()
        if (
            not SOURCE_ID_RE.fullmatch(source_id)
            or not title
            or not re.match(r"^https?://", url, re.I)
            or source_id in source_ids
        ):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        source_ids.add(source_id)
        sources.append({"id": source_id, "title": title, "url": url})

    raw_materials = payload.get("materials")
    if not isinstance(raw_materials, list) or not raw_materials:
        raise ValueError("TOPIC_NOT_FOUND")
    materials: list[dict[str, object]] = []
    verified: dict[str, str] = {}
    for raw in raw_materials[:5]:
        assert isinstance(raw, dict)
        material_id = str(raw.get("id", "")).strip()
        facet = str(raw.get("facet", "")).strip()
        answer = str(raw.get("answer", "")).strip()
        fact = str(raw.get("fact", "")).strip()
        ids = raw.get("source_ids")
        if (
            not MATERIAL_ID_RE.fullmatch(material_id)
            or not facet
            or not answer
            or not fact
            or answer not in fact
            or GENERATED_MARKUP_RE.search(f"{facet} {answer} {fact}")
            or not isinstance(ids, list)
            or not ids
            or any(str(source_id) not in source_ids for source_id in ids)
            or normalize_key(answer) in verified
        ):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        quote = fact + " " + "".join(f"[{source_id}]" for source_id in ids)
        verified[normalize_key(answer)] = quote
        materials.append(
            {"id": material_id, "facet": facet, "answer": answer, "quote": quote}
        )

    distractors: list[dict[str, str]] = []
    for raw in payload.get("distractors", []):
        assert isinstance(raw, dict)
        name = str(raw.get("name", "")).strip()
        ids = raw.get("source_ids")
        if (
            not name
            or GENERATED_MARKUP_RE.search(name)
            or not isinstance(ids, list)
            or not ids
            or any(str(source_id) not in source_ids for source_id in ids)
            or normalize_key(name) in verified
        ):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        quote = name + "은(는) 검색 문서에서 확인된 실제 객관식 후보 명칭이다 " + "".join(
            f"[{source_id}]" for source_id in ids
        )
        verified[normalize_key(name)] = quote
        distractors.append({"name": name, "quote": quote})
    if len(distractors) < required_distractor_count:
        raise ValueError("MODEL_OUTPUT_FORMAT")

    return {
        "materials": materials,
        "distractors": distractors,
        "sources": sources,
        "verified": verified,
    }


def fixture(
    topic: str, answer: str, fact: str, distractor_names: list[str] | None = None
) -> dict[str, object]:
    assert topic and answer in fact
    names = distractor_names or ["알파", "베타", "감마", "델타"]
    assert len(names) == 4 and answer not in names
    return {
        "materials": [
            {
                "id": "M1",
                "facet": "검증 소재",
                "answer": answer,
                "fact": fact,
                "source_ids": ["S1"],
            }
        ],
        "distractors": [{"name": name, "source_ids": ["S1"]} for name in names],
        "sources": [
            {"id": "S1", "title": f"{topic} 검증 문서", "url": "https://example.test/source"}
        ],
        "partial": False,
        "warnings": [],
    }


class QuizEvidenceContractTests(unittest.TestCase):
    def test_plausible_topics_are_not_locally_blocked(self) -> None:
        cases: dict[str, tuple[str, str, list[str]]] = {
            "333큐브": ("CFOP", "333큐브의 대표적인 해법 가운데 하나는 CFOP이다.", ["Roux", "ZZ", "Petrus", "Corners-first"]),
            "루빅스큐브": ("CFOP", "루빅스큐브를 맞추는 해법 가운데 하나는 CFOP이다.", ["Roux", "ZZ", "Petrus", "Corners-first"]),
            "빅뱅": ("우주배경복사", "빅뱅 우주론의 관측 근거에는 우주배경복사가 포함된다.", ["정상상태 우주론", "우주 인플레이션", "진동 우주론", "다중우주"]),
            "수박": ("시트룰린", "수박에는 시트룰린이라는 아미노산이 들어 있다.", ["라이코펜", "아르기닌", "베타카로틴", "쿠쿠르비타신"]),
            "세계": ("본초자오선", "세계 표준시의 기준 경도선은 본초자오선이다.", ["적도", "날짜변경선", "북회귀선", "남회귀선"]),
            "가슴": ("흉골", "가슴 앞쪽 중앙에는 흉골이 위치한다.", ["늑골", "쇄골", "흉추", "횡격막"]),
            "남자": ("XY", "남자의 성염색체 조합을 설명할 때 대표적으로 XY를 든다.", ["XX", "XYY", "XXY", "XO"]),
            "xy염색체의 인간": ("Y염색체", "xy염색체의 인간을 설명하는 핵심 염색체 중 하나는 Y염색체다.", ["X염색체", "SRY", "XIST", "PAR"]),
            "여성이 아닌 인간": ("성별", "여성이 아닌 인간이라는 표현은 성별 분류와 관련된다.", ["성정체성", "생물학적 성", "법적 성별", "젠더"]),
            "음경을 가진 인간": ("비뇨생식계", "음경을 가진 인간의 해부학은 비뇨생식계와 관련된다.", ["소화계", "호흡계", "림프계", "내분비계"]),
            "음경": ("해면체", "음경의 내부 구조에는 해면체가 있다.", ["요도", "귀두", "포피", "요도해면체"]),
        }
        for topic, (answer, fact, distractors) in cases.items():
            with self.subTest(topic=topic):
                result = validate_structured_response(fixture(topic, answer, fact, distractors))
                self.assertEqual(result["materials"][0]["answer"], answer)
                self.assertEqual(len(result["distractors"]), 4)
                self.assertIn(normalize_key(answer), result["verified"])

    def test_source_url_is_allowed_but_not_projected_to_model(self) -> None:
        result = validate_structured_response(
            fixture("루빅스큐브", "CFOP", "루빅스큐브의 해법에는 CFOP가 있다.")
        )
        prompt_sources = [
            {"id": source["id"], "title": source["title"]} for source in result["sources"]
        ]
        self.assertIn("url", result["sources"][0])
        self.assertNotIn("url", prompt_sources[0])

    def test_generated_url_unknown_source_and_missing_answer_are_rejected(self) -> None:
        base = fixture("수박", "시트룰린", "수박에는 시트룰린이 들어 있다.")
        bad_url = {**base, "materials": [dict(base["materials"][0])]}
        bad_url["materials"][0]["fact"] += " https://fake.example/"
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(bad_url)

        bad_source = {**base, "materials": [dict(base["materials"][0])]}
        bad_source["materials"][0]["source_ids"] = ["S9"]
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(bad_source)

        missing_answer = {**base, "materials": [dict(base["materials"][0])]}
        missing_answer["materials"][0]["fact"] = "수박은 박과의 식물이다."
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(missing_answer)

        too_few_distractors = {**base, "distractors": list(base["distractors"][:3])}
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(too_few_distractors)

    def test_javascript_messages_do_not_promise_retry(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "Bots"
            / "상식퀴즈봇"
            / "상식퀴즈봇.js"
        ).read_text(encoding="utf-8")
        self.assertNotIn("잠시 후 다시 시도해주세요.", source)
        self.assertIn("현재 요청은 종료되었습니다.", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
