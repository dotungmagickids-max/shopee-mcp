import { loadHistory, loadLaunch } from "@/lib/facebook/launch-data";
import { webCanCreate } from "@/lib/facebook/launch";
import { PAGES } from "@/lib/facebook/magic-data";
import History from "./history";
import Launcher from "./launcher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_PAGE = "159993608025607"; // Magic Kids

export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ page?: string; posts?: string; draft?: string; shape?: string }> }) {
  const sp = await searchParams;
  const pageId = sp.page && PAGES[sp.page] ? sp.page : DEFAULT_PAGE;
  const preselect = (sp.posts ?? "").split(",").filter((x) => /^\d+_\d+$/.test(x)).slice(0, 30);
  let data: Awaited<ReturnType<typeof loadLaunch>> | null = null;
  let error: string | null = null;
  const historyP = loadHistory().catch((e) => ({ runs: [], tableReady: false, error: e instanceof Error ? e.message : String(e) }));
  try {
    // Bài chọn sẵn từ màn Đề xuất có thể cũ hơn 30 ngày (bài thắng chạy lâu): đọc rộng ra 60 ngày.
    data = await loadLaunch(pageId, preselect.length ? 60 : 30);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const history = await historyP;
  return (
    <>
      <div className="card">
        <h1>Lên camp</h1>
        <div className="filters">
          {Object.entries(PAGES).map(([id, name]) => (
            <a key={id} href={`/fb/len-camp?page=${id}`} className={id === pageId ? "on" : ""}>
              {name}
            </a>
          ))}
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          Bài và reel {preselect.length ? 60 : 30} ngày gần nhất của page. Mọi thứ tạo ra đều ở trạng thái <b>tạm dừng</b>; bật từng cái sau.
        </p>
        {!webCanCreate(pageId) ? (
          <p className="warnbox">
            Page {PAGES[pageId]}: web chỉ <b>lưu nháp</b>, không tạo được quảng cáo (page không thuộc doanh nghiệp của web). Chọn bài, Xem trước, Lưu nháp rồi nhắn
            em số nháp để em lên theo quy trình chuẩn.
          </p>
        ) : null}
        {error ? <p className="error">Không tải được bài: {error}</p> : null}
        {data?.errors.length ? <p className="error">Thiếu số: {data.errors.join("; ").slice(0, 500)}</p> : null}
      </div>
      {data ? <Launcher pageId={pageId} pageName={PAGES[pageId]} posts={data.posts} accounts={data.accounts} usedNames={data.usedNames} usedCampaigns={data.usedCampaigns} drafts={data.drafts} preselect={preselect} initialShape={sp.shape === "1-n-1" || sp.shape === "1-1-n" || sp.shape === "n-1-1" ? sp.shape : undefined} openDraftId={Number(sp.draft) || undefined} /> : null}
      <History runs={history.runs} accounts={data?.accounts ?? []} pages={PAGES} tableReady={history.tableReady} error={history.error} />
    </>
  );
}
