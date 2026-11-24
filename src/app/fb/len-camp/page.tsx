import { loadLaunch } from "@/lib/facebook/launch-data";
import { PAGES } from "@/lib/facebook/magic-data";
import Launcher from "./launcher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_PAGE = "159993608025607"; // Magic Kids

export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ page?: string; posts?: string; draft?: string }> }) {
  const sp = await searchParams;
  const pageId = sp.page && PAGES[sp.page] ? sp.page : DEFAULT_PAGE;
  const preselect = (sp.posts ?? "").split(",").filter((x) => /^\d+_\d+$/.test(x)).slice(0, 30);
  let data: Awaited<ReturnType<typeof loadLaunch>> | null = null;
  let error: string | null = null;
  try {
    data = await loadLaunch(pageId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
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
          Bài và reel 30 ngày gần nhất của page. Mọi thứ tạo ra đều ở trạng thái <b>tạm dừng</b>; bật từng cái sau.
        </p>
        {error ? <p className="error">Không tải được bài: {error}</p> : null}
        {data?.errors.length ? <p className="error">Thiếu số: {data.errors.join("; ").slice(0, 500)}</p> : null}
      </div>
      {data ? <Launcher pageId={pageId} pageName={PAGES[pageId]} posts={data.posts} accounts={data.accounts} usedNames={data.usedNames} usedCampaigns={data.usedCampaigns} drafts={data.drafts} preselect={preselect} openDraftId={Number(sp.draft) || undefined} /> : null}
    </>
  );
}
