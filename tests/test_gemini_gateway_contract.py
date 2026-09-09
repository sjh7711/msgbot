from gemini_gateway_live_probe import decode_gateway_response


def test_http_200_search_without_evidence_is_failure():
    result = decode_gateway_response(
        200,
        {
            "route": "web_search",
            "answer": "검색 결과를 찾지 못했습니다.",
            "searched": True,
            "sources": [],
            "search": {"results": 0},
        },
        "",
        "수인분당선 6량 편성 이유",
    )
    assert result["ok"] is False
    assert result["error_code"] == "SEARCH_NO_EVIDENCE"
    assert result["connect_failed"] is False


def test_search_source_requires_http_url():
    result = decode_gateway_response(
        200,
        {
            "route": "web_search",
            "answer": "제목만 있는 검색 결과",
            "searched": True,
            "sources": [{"source_id": "S1", "title": "제목뿐", "final_url": ""}],
            "search": {"results": 1},
        },
        "",
        "검색 질문",
    )
    assert result["error_code"] == "SEARCH_NO_EVIDENCE"
    assert result["source_count"] == 0


def test_grounded_search_stays_successful():
    result = decode_gateway_response(
        200,
        {
            "route": "web_search",
            "answer": "근거가 있는 답 [S1]",
            "searched": True,
            "sources": [
                {
                    "source_id": "S1",
                    "title": "공식 자료",
                    "final_url": "https://example.com/source",
                }
            ],
            "search": {"results": 1},
        },
        "",
        "검색 질문",
    )
    assert result["ok"] is True
    assert result["source_count"] == 1


def test_structured_server_error_is_preserved():
    result = decode_gateway_response(
        429,
        {"error": {"code": "RATE_LIMITED", "message": "사용량 초과", "retryable": True}},
        "",
        "질문",
    )
    assert result["error_code"] == "RATE_LIMITED"
    assert result["retryable"] is True
    assert result["connect_failed"] is False


def test_legacy_search_source_error_blocks_ungrounded_fallback():
    result = decode_gateway_response(
        503,
        {"detail": "내부 LLM이 검색 답변에 출처를 표시하지 않았습니다"},
        "",
        "수인분당선 6량 편성 이유",
    )
    assert result["error_code"] == "SEARCH_NO_EVIDENCE"
    assert result["connect_failed"] is False
