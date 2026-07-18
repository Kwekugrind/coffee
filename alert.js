import WebSocket from "ws";

const ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

ws.on("open", () => {
  ws.send(JSON.stringify({ active_symbols: "brief", product_type: "basic" }));
});

ws.on("message", (data) => {
  const response = JSON.parse(data);
  if (response.active_symbols) {
    console.log("AVAILABLE SYMBOLS:");
    response.active_symbols.forEach(s => console.log(s.symbol));
    ws.close();
  }
});
