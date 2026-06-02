// Outgoing WebSocket simulation patcher for network latency, drops, and reconnects

export function initDebugPanel(provider) {
  const panel = document.getElementById('debug-panel');
  const closeBtn = document.getElementById('close-debug');
  const latencySlider = document.getElementById('latency-slider');
  const lossSlider = document.getElementById('loss-slider');
  const latencyValue = document.getElementById('latency-value');
  const lossValue = document.getElementById('loss-value');
  const killBtn = document.getElementById('kill-connection');

  const debugConnStatus = document.getElementById('debug-conn-status');
  const debugMsgSent = document.getElementById('debug-msg-sent');
  const debugMsgDropped = document.getElementById('debug-msg-dropped');

  let config = {
    latency: 0,
    loss: 0,
    sent: 0,
    dropped: 0
  };

  // Toggle debug panel visible
  window.toggleDebugPanel = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      window.showToast?.('Debug panel opened', 'info', 1500);
    }
  };

  closeBtn?.addEventListener('click', () => {
    panel.hidden = true;
  });

  // Slider change listeners
  latencySlider?.addEventListener('input', (e) => {
    config.latency = parseInt(e.target.value);
    latencyValue.textContent = `${config.latency}ms`;
    patchWebSocketSend(provider, config);
  });

  lossSlider?.addEventListener('input', (e) => {
    config.loss = parseInt(e.target.value);
    lossValue.textContent = `${config.loss}%`;
    patchWebSocketSend(provider, config);
  });

  // Intercept WebSocket disconnection simulated tests
  killBtn?.addEventListener('click', () => {
    if (provider.wsconnected) {
      provider.disconnect();
      window.showToast?.('Forced WebSocket connection drop!', 'warning', 3000);
      killBtn.textContent = 'Reconnect Socket';
    } else {
      provider.connect();
      window.showToast?.('Reconnecting WebSocket...', 'info', 2000);
      killBtn.textContent = 'Disconnect Socket';
    }
  });

  // Loop to update active indicators in the debug UI
  setInterval(() => {
    if (panel.hidden) return;

    // Status label
    if (provider.wsconnected) {
      debugConnStatus.textContent = '🟢 Online';
      debugConnStatus.style.color = 'var(--color-online)';
      killBtn.textContent = 'Disconnect Socket';
    } else {
      debugConnStatus.textContent = '🔴 Offline';
      debugConnStatus.style.color = 'var(--color-offline)';
      killBtn.textContent = 'Reconnect Socket';
    }

    debugMsgSent.textContent = config.sent;
    debugMsgDropped.textContent = config.dropped;
  }, 500);
}

function patchWebSocketSend(provider, config) {
  const ws = provider.ws;
  if (!ws) return;

  // Intercept raw WebSocket send command if not already intercepted
  if (!ws._syncanvasOriginalSend) {
    ws._syncanvasOriginalSend = ws.send;
  }

  // Intercept and redirect send calls
  ws.send = function (data) {
    // 1. Packet Loss Check
    if (config.loss > 0 && Math.random() * 100 < config.loss) {
      config.dropped++;
      console.warn(`[Network Sim] Jitter simulation: dropped outbound WS packet.`);
      return; // Discard data
    }

    config.sent++;

    // 2. Latency Delay Check
    if (config.latency > 0) {
      setTimeout(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws._syncanvasOriginalSend.call(ws, data);
          }
        } catch (err) {
          console.error('[Network Sim] Latency timeout packet transmit error:', err);
        }
      }, config.latency);
    } else {
      try {
        ws._syncanvasOriginalSend.call(ws, data);
      } catch (err) {
        console.error('[Network Sim] Original send transmit error:', err);
      }
    }
  };
}
