"""퀴즈 근거 전용 API compact v3와 상식퀴즈봇 사이의 계약 회귀 테스트.

실제 검색/Gemini를 호출하지 않는다. v3의 핵심인 토픽 의미 고정과
material별 정답·오답 묶음을 Python으로 미러링한다.
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
ANSWER_TYPES = {
    "person", "organization", "place", "work", "product", "method", "term",
    "event", "year", "date", "count", "measurement",
}
SCALAR_TYPES = {"year", "date", "count", "measurement"}


def normalize_key(value: object) -> str:
    return re.sub(r"\s+", "", str(value).strip().lower())


def _source_ids(raw: object, known: set[str]) -> list[str]:
    if not isinstance(raw, list) or not raw or any(str(item) not in known for item in raw):
        raise ValueError("MODEL_OUTPUT_FORMAT")
    return list(dict.fromkeys(map(str, raw)))


def _evidence(raw: object, known: set[str]) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("MODEL_OUTPUT_FORMAT")
    result: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        source_id = str(entry.get("source_id", "")).strip()
        quote = str(entry.get("quote", "")).strip()
        if source_id not in known or not quote or GENERATED_MARKUP_RE.search(quote):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        result.append({"source_id": source_id, "quote": quote})
    return result


def validate_structured_response(
    payload: dict[str, object], *, requested_topic: str, required_distractor_count: int = 4
) -> dict[str, object]:
    """lib/quiz-evidence.js validateSuccess의 compact v3 핵심 계약을 미러링한다."""

    if payload.get("schema_version") != 3:
        raise ValueError("MODEL_OUTPUT_FORMAT")

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

    resolved = payload.get("resolved_topic")
    if not isinstance(resolved, dict) or not isinstance(resolved.get("aliases"), list):
        raise ValueError("MODEL_OUTPUT_FORMAT")
    resolved_name = str(resolved.get("name", "")).strip()
    resolved_sense = str(resolved.get("sense", "")).strip()
    resolved_names = {normalize_key(resolved_name), *map(normalize_key, resolved["aliases"])}
    if (
        not resolved_name
        or not resolved_sense
        or GENERATED_MARKUP_RE.search(f"{resolved_name} {resolved_sense}")
        or normalize_key(requested_topic) not in resolved_names
    ):
        raise ValueError("MODEL_OUTPUT_FORMAT")

    raw_materials = payload.get("materials")
    if not isinstance(raw_materials, list) or not raw_materials:
        raise ValueError("TOPIC_NOT_FOUND")
    materials: list[dict[str, object]] = []
    material_answers: set[str] = set()
    material_ids: set[str] = set()
    for raw in raw_materials[:5]:
        assert isinstance(raw, dict)
        material_id = str(raw.get("id", "")).strip()
        facet = str(raw.get("facet", "")).strip()
        answer = str(raw.get("answer", "")).strip()
        answer_type = str(raw.get("answer_type", "")).strip()
        choice_mode = str(raw.get("choice_mode", "")).strip()
        fact = str(raw.get("fact", "")).strip()
        ids = _source_ids(raw.get("source_ids"), source_ids)
        _evidence(raw.get("evidence"), source_ids)
        raw_distractors = raw.get("distractors")
        if (
            not MATERIAL_ID_RE.fullmatch(material_id)
            or material_id in material_ids
            or not facet
            or not answer
            or answer_type not in ANSWER_TYPES
            or choice_mode not in {"grounded", "scalar"}
            or (choice_mode == "scalar" and answer_type not in SCALAR_TYPES)
            or not fact
            or answer not in fact
            or GENERATED_MARKUP_RE.search(f"{facet} {answer} {fact}")
            or normalize_key(answer) in material_answers
            or not isinstance(raw_distractors, list)
        ):
            raise ValueError("MODEL_OUTPUT_FORMAT")
        if required_distractor_count and len(raw_distractors) != required_distractor_count:
            raise ValueError("INSUFFICIENT_DISTRACTORS")

        distractors: list[dict[str, object]] = []
        local_names = {normalize_key(answer)}
        for raw_distractor in raw_distractors:
            assert isinstance(raw_distractor, dict)
            name = str(raw_distractor.get("name", "")).strip()
            name_key = normalize_key(name)
            if not name or name_key in local_names or GENERATED_MARKUP_RE.search(name):
                raise ValueError("MODEL_OUTPUT_FORMAT")
            if choice_mode == "scalar":
                if raw_distractor.get("synthetic") is not True:
                    raise ValueError("MODEL_OUTPUT_FORMAT")
                distractors.append({"name": name, "synthetic": True})
            else:
                distractor_ids = _source_ids(raw_distractor.get("source_ids"), source_ids)
                if raw_distractor.get("synthetic") is True:
                    raise ValueError("MODEL_OUTPUT_FORMAT")
                distractors.append(
                    {"name": name, "source_ids": distractor_ids, "synthetic": False}
                )
            local_names.add(name_key)

        quote = fact + " " + "".join(f"[{source_id}]" for source_id in ids)
        materials.append(
            {
                "id": material_id,
                "facet": facet,
                "answer": answer,
                "answer_type": answer_type,
                "choice_mode": choice_mode,
                "quote": quote,
                "distractors": distractors,
                "verified": {normalize_key(answer), *local_names},
            }
        )
        material_ids.add(material_id)
        material_answers.add(normalize_key(answer))

    return {
        "schema_version": 3,
        "resolved_topic": resolved,
        "materials": materials,
        "sources": sources,
        "partial": payload.get("partial") is True,
        "warnings": list(payload.get("warnings", [])),
    }


def fixture(
    topic: str,
    answer: str,
    fact: str,
    distractor_names: list[str] | None = None,
    *,
    answer_type: str = "term",
    choice_mode: str = "grounded",
) -> dict[str, object]:
    assert topic and answer in fact
    names = distractor_names or ["알파", "베타", "감마", "델타"]
    assert len(names) == 4 and answer not in names
    if choice_mode == "scalar":
        distractors = [{"name": name, "synthetic": True} for name in names]
    else:
        distractors = [
            {"name": name, "source_ids": ["S1"]}
            for name in names
        ]
    return {
        "schema_version": 3,
        "resolved_topic": {"name": topic, "sense": f"{topic} 퀴즈 대상", "aliases": [topic]},
        "materials": [
            {
                "id": "M1",
                "facet": "검증 소재",
                "answer": answer,
                "answer_type": answer_type,
                "choice_mode": choice_mode,
                "fact": fact,
                "source_ids": ["S1"],
                "evidence": [{"source_id": "S1", "quote": fact}],
                "distractors": distractors,
            }
        ],
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
                result = validate_structured_response(
                    fixture(topic, answer, fact, distractors), requested_topic=topic
                )
                material = result["materials"][0]
                self.assertEqual(material["answer"], answer)
                self.assertEqual([item["name"] for item in material["distractors"]], distractors)

    def test_source_url_is_allowed_but_not_projected_to_model(self) -> None:
        result = validate_structured_response(
            fixture("루빅스큐브", "CFOP", "루빅스큐브의 해법에는 CFOP가 있다."),
            requested_topic="루빅스큐브",
        )
        prompt_sources = [
            {"id": source["id"], "title": source["title"]} for source in result["sources"]
        ]
        self.assertIn("url", result["sources"][0])
        self.assertNotIn("url", prompt_sources[0])

    def test_legacy_schemas_and_contract_violations_are_rejected(self) -> None:
        base = fixture("수박", "시트룰린", "수박에는 시트룰린이 들어 있다.")
        v1 = {key: value for key, value in base.items() if key != "schema_version"}
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(v1, requested_topic="수박")
        v2 = {**base, "schema_version": 2}
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(v2, requested_topic="수박")

        bad_url = {**base, "materials": [dict(base["materials"][0])]}
        bad_url["materials"][0]["fact"] += " https://fake.example/"
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(bad_url, requested_topic="수박")

        bad_source = {**base, "materials": [dict(base["materials"][0])]}
        bad_source["materials"][0]["source_ids"] = ["S9"]
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(bad_source, requested_topic="수박")

        too_few = {**base, "materials": [dict(base["materials"][0])]}
        too_few["materials"][0]["distractors"] = list(base["materials"][0]["distractors"][:3])
        with self.assertRaisesRegex(ValueError, "INSUFFICIENT_DISTRACTORS"):
            validate_structured_response(too_few, requested_topic="수박")

    def test_material_distractors_are_isolated(self) -> None:
        payload = fixture(
            "루빅스큐브", "CFOP", "루빅스큐브의 해법에는 CFOP가 있다.",
            ["Roux", "ZZ", "Petrus", "Corners-first"], answer_type="method",
        )
        second = fixture(
            "루빅스큐브", "1974년", "루빅스큐브는 1974년에 발명되었다.",
            ["1971년", "1972년", "1973년", "1975년"],
            answer_type="year", choice_mode="scalar",
        )["materials"][0]
        second["id"] = "M2"
        payload["materials"].append(second)
        # v1의 전역 필드가 있어도 어느 material의 보기 집합에도 합쳐지지 않는다.
        payload["distractors"] = [{"name": "1985년"}]
        result = validate_structured_response(payload, requested_topic="루빅스큐브")
        self.assertEqual(
            [item["name"] for item in result["materials"][0]["distractors"]],
            ["Roux", "ZZ", "Petrus", "Corners-first"],
        )
        self.assertEqual(
            [item["name"] for item in result["materials"][1]["distractors"]],
            ["1971년", "1972년", "1973년", "1975년"],
        )

    def test_partial_response_with_one_material_is_success(self) -> None:
        payload = fixture("텔레칩스", "Dolphin3", "텔레칩스는 Dolphin3를 공개했다.")
        payload["partial"] = True
        payload["warnings"] = ["불완전한 소재 4개를 제외했습니다."]
        result = validate_structured_response(payload, requested_topic="텔레칩스")
        self.assertEqual(result["schema_version"], 3)
        self.assertTrue(result["partial"])
        self.assertEqual(len(result["materials"]), 1)

    def test_scalar_distractors_must_be_synthetic(self) -> None:
        payload = fixture(
            "루빅스큐브", "1974년", "루빅스큐브는 1974년에 발명되었다.",
            ["1971년", "1972년", "1973년", "1975년"],
            answer_type="year", choice_mode="scalar",
        )
        result = validate_structured_response(payload, requested_topic="루빅스큐브")
        self.assertTrue(all(item["synthetic"] for item in result["materials"][0]["distractors"]))
        payload["materials"][0]["distractors"][0]["synthetic"] = False
        with self.assertRaisesRegex(ValueError, "MODEL_OUTPUT_FORMAT"):
            validate_structured_response(payload, requested_topic="루빅스큐브")

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
