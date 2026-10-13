// Child-process HTTP + WebSocket server for preview.test.ts: run as its own process so its port belongs to another pid than the test hostd.
type WsData = { search: string; cookie: string; origin: string };
const server: Bun.Server<WsData> = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv): Response | undefined {
    const u = new URL(req.url);
    if (u.pathname === "/ws" && srv.upgrade(req, { data: { search: u.search, cookie: req.headers.get("cookie") ?? "none", origin: req.headers.get("origin") ?? "none" } })) return undefined;
    // absolute Location built from this server's own address, the way a framework does from the Host it sees
    if (u.pathname === "/redir") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:" + server.port + "/target" } });
    return new Response("upstream " + u.pathname + u.search + " enc=" + (req.headers.get("accept-encoding") ?? "none") + " host=" + (req.headers.get("host") ?? "none") + " xff=" + (req.headers.get("x-forwarded-for") ?? "none") + " origin=" + (req.headers.get("origin") ?? "none") + " referer=" + (req.headers.get("referer") ?? "none"));
  },
  websocket: { message(ws, m) { ws.send("echo " + String(m) + " q=" + ws.data.search + " cookie=" + ws.data.cookie + " origin=" + ws.data.origin); } },
});
console.log(String(server.port));
