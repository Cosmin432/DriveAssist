let ws = null;
let wsConnected = false;

export function connectWebSocket(onData, onConnected) {
  try {
    ws = new WebSocket('ws://10.177.102.15:8765');

    ws.onopen = () => {
      wsConnected = true;
      onConnected?.();
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await onData(data);
      } catch (err) {
        console.error('[WS] parse error:', err);
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      setTimeout(() => connectWebSocket(onData, onConnected), 3000);
    };

    ws.onerror = () => {
      wsConnected = false;
      ws.close();
    };
  } catch {
    wsConnected = false;
  }
}

export function isConnected() {
  return wsConnected;
}