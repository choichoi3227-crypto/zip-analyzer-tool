import React, { useState } from "react";
import "./App.css";

function App() {
  const [zipFile, setZipFile] = useState(null);
  const [rules, setRules] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = (e) => setZipFile(e.target.files[0]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!zipFile || !rules.trim() || !apiKey.trim()) {
      setError("모든 필드를 채워주세요.");
      return;
    }
    setLoading(true);

    const formData = new FormData();
    formData.append("zipfile_input", zipFile);
    formData.append("rules", rules);
    formData.append("api_key", apiKey);

    try {
      const res = await fetch("https://<YOUR_API_DOMAIN_OR_WORKERS_URL>/api/analyze", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("분석 실패");

      const data = await res.json();
      setResult(data);
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <h1>ZIP 파일 분석·편집 도구(Gemini, Cloudflare KV)</h1>
      <form onSubmit={handleSubmit} className="form">
        <div>
          <label>ZIP 파일 업로드: </label>
          <input type="file" accept=".zip" onChange={handleFile} />
        </div>
        <div>
          <label>규칙(자연어): </label>
          <textarea
            value={rules}
            onChange={e => setRules(e.target.value)}
            placeholder="예) 모든 txt 파일의 이메일 패턴을 제거해줘"
            rows={3}
            required
          />
        </div>
        <div>
          <label>Gemini API 키: </label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="AI key 입력"
            required
          />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "분석 중..." : "실행"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}

      {result && (
        <div className="result">
          <h2>결과</h2>
          <div>파일 수: {result.files_found}</div>
          <div>Gemini 응답: 
            <pre style={{whiteSpace:"pre-wrap", background:"#f7f7f7", borderRadius:"8px"}}>{result.gemini_analysis}</pre>
          </div>
          <div>
            <strong>작업 로그:</strong>
            <ul>
              {result.result_log.details.map((d, i) => (<li key={i}>{d}</li>))}
            </ul>
          </div>
          <a
            href={`https://<YOUR_API_DOMAIN_OR_WORKERS_URL>${result.download_url}`}
            download
            className="download-link"
          >
            ZIP 파일 다운로드
          </a>
        </div>
      )}
    </div>
  );
}

export default App;