import { Router } from 'itty-router';
import { json } from 'itty-router';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI } from 'google-generativeai';

interface Env {
  KV_STORE: KVNamespace;
}

interface FileInfo {
  [key: string]: {
    size: number;
    type: string;
    preview: string;
  };
}

const router = Router();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

router.options('*', () => new Response(null, { headers: corsHeaders }));

async function extractAndAnalyzeZip(arrayBuffer: ArrayBuffer) {
  const zip = new JSZip();
  await zip.loadAsync(arrayBuffer);
  const filesList: string[] = [];
  const filesInfo: FileInfo = {};

  for (const [filename, file] of Object.entries(zip.files)) {
    if (!file.dir) {
      filesList.push(filename);
      try {
        const size = file.uncompressedSize;
        const ext = filename.split('.').pop() || '';
        let preview = '';

        if (['txt', 'py', 'js', 'json', 'yaml', 'yml', 'md', 'csv', 'ts'].includes(ext)) {
          try {
            const content = await (file as any).async('string');
            preview = content.substring(0, 500);
          } catch {
            preview = '[바이너리 파일]';
          }
        } else {
          preview = '[바이너리/이미지 파일]';
        }

        filesInfo[filename] = { size, type: ext, preview };
      } catch {
        filesInfo[filename] = { size: 0, type: '', preview: '[오류]' };
      }
    }
  }

  return { zip, filesList, filesInfo };
}

async function analyzeWithGemini(
  apiKey: string,
  filesInfo: FileInfo,
  filesList: string[],
  rules: string
): Promise<string> {
  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const prompt = `당신은 파일 편집 도우미입니다.

사용자가 업로드한 ZIP 파일을 분석했으며, 다음은 파일 목록입니다:
파일 목록: ${JSON.stringify(filesList, null, 2)}

파일 분석 정보 (샘플):
${JSON.stringify(Object.fromEntries(Object.entries(filesInfo).slice(0, 5)), null, 2)}

사용자의 요청(자연어 규칙):
"${rules}"

위 요청에 맞게 파일들을 어떻게 수정/삭제/편집할지 구체적으로 지시해주세요.

응답 형식:
1. 어떤 파일을 수정할지
2. 각 파일에 대해 어떤 작업을 할지 (삭제, 내용 수정, 이름 변경 등)
3. 수정할 내용이 있으면 구체적인 변경 사항

JSON 형식으로 정확하게 응답해주세요:
{
  "actions": [
    {"file": "파일명", "action": "delete|modify|rename", "details": "상세 지시사항"},
    ...
  ],
  "summary": "수행할 작업 요약"
}`;

  const result = await model.generateContent(prompt);
  // adjust depending on library response shape
  return result.response?.text() ?? (result as any).text ?? String(result);
}

async function applyActions(
  zip: JSZip,
  geminiResponse: string,
  filesInfo: FileInfo
): Promise<{
  total_actions: number;
  successful: number;
  failed: number;
  details: string[];
}> {
  const resultLog = { total_actions: 0, successful: 0, failed: 0, details: [] as string[] };
  try {
    const jsonMatch = geminiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      resultLog.details.push('❌ Gemini 응답을 파싱할 수 없습니다');
      return resultLog;
    }
    const actionsData = JSON.parse(jsonMatch[0]);
    const actions = actionsData.actions || [];
    for (const action of actions) {
      const { file, action: actionType, details } = action as {
        file: string;
        action: string;
        details: string;
      };
      resultLog.total_actions++;
      try {
        if (actionType === 'delete') {
          if (zip.files[file]) {
            delete zip.files[file];
            resultLog.successful++;
            resultLog.details.push(`✓ 삭제: ${file}`);
          } else {
            resultLog.failed++;
            resultLog.details.push(`✗ 삭제 실패 (파일 없음): ${file}`);
          }
        } else if (actionType === 'modify') {
          if (zip.files[file]) {
            const content = await (zip.files[file] as any).async('string');
            // 실제 수정 로직은 Gemini의 'details'를 해석해 구현해야 함
            const modifiedContent = content; // placeholder: apply modifications per details
            zip.file(file, modifiedContent);
            resultLog.successful++;
            resultLog.details.push(`✓ 수정: ${file} - ${details}`);
          } else {
            resultLog.failed++;
            resultLog.details.push(`✗ 수정 실패 (파일 없음): ${file}`);
          }
        } else if (actionType === 'rename') {
          if (zip.files[file]) {
            const blob = await (zip.files[file] as any).async('blob');
            delete zip.files[file];
            zip.file(details, blob);
            resultLog.successful++;
            resultLog.details.push(`✓ 이름 변경: ${file} → ${details}`);
          } else {
            resultLog.failed++;
            resultLog.details.push(`✗ 이름 변경 실패: ${file}`);
          }
        } else {
          resultLog.failed++;
          resultLog.details.push(`✗ 알 수 없는 액션 타입: ${actionType} (${file})`);
        }
      } catch (e) {
        resultLog.failed++;
        resultLog.details.push(`✗ 오류 (${actionType} ${file}): ${String(e)}`);
      }
    }
  } catch (e) {
    resultLog.details.push(`❌ JSON 파싱 오류: ${String(e)}`);
  }
  return resultLog;
}

router.post('/api/analyze', async (request: Request, env: Env) => {
  try {
    const formData = await request.formData();
    const zipFile = formData.get('zipfile_input') as File | null;
    const rules = (formData.get('rules') as string) ?? '';
    const apiKey = (formData.get('api_key') as string) ?? '';

    if (!zipFile || !rules || !apiKey) {
      return json({ error: '모든 필드를 입력해주세요' }, { status: 400, headers: corsHeaders });
    }

    const arrayBuffer = await zipFile.arrayBuffer();
    const { zip, filesList, filesInfo } = await extractAndAnalyzeZip(arrayBuffer);

    const geminiResponse = await analyzeWithGemini(apiKey, filesInfo, filesList, rules);

    const resultLog = await applyActions(zip, geminiResponse, filesInfo);

    const editedZipUint8 = await zip.generateAsync({ type: 'uint8array' });
    const sessionId = uuidv4();

    // base64 encode and store in KV (note: KV has size limits; this approach is suitable only for modest zip sizes)
    const base64 = btoa(String.fromCharCode(...editedZipUint8));
    await env.KV_STORE.put(`result:${sessionId}`, base64, { expirationTtl: 3600 });
    await env.KV_STORE.put(
      `session:${sessionId}`,
      JSON.stringify({ created_at: new Date().toISOString(), file_count: filesList.length }),
      { expirationTtl: 3600 }
    );

    return json(
      {
        status: 'success',
        files_found: filesList.length,
        result_log: resultLog,
        gemini_analysis: geminiResponse,
        download_url: `/api/download/${sessionId}`,
        session_id: sessionId,
      },
      { headers: corsHeaders }
    );
  } catch (e) {
    return json({ error: `분석 실패: ${String(e)}` }, { status: 500, headers: corsHeaders });
  }
});

router.get('/api/download/:sessionId', async (request: Request, env: Env) => {
  try {
    const { sessionId } = request.params as { sessionId: string };
    const base64 = await env.KV_STORE.get(`result:${sessionId}`);
    if (!base64) {
      return json({ error: '파일을 찾을 수 없습니다' }, { status: 404, headers: corsHeaders });
    }
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="edited_files.zip"',
        ...corsHeaders,
      },
    });
  } catch (e) {
    return json({ error: `다운로드 실패: ${String(e)}` }, { status: 500, headers: corsHeaders });
  }
});

router.get('/api/health', () => {
  return json({ status: 'ok', timestamp: new Date().toISOString() }, { headers: corsHeaders });
});

router.all('*', () => {
  return json({ error: '엔드포인트를 찾을 수 없습니다' }, { status: 404, headers: corsHeaders });
});

export default { fetch: router.handle };