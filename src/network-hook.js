(() => {
  if (window.__tableExtractNetworkHookLoaded) {
    return;
  }

  window.__tableExtractNetworkHookLoaded = true;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  window.fetch = async (...args) => {
    const requestInfo = captureFetchRequest(args);
    const response = await originalFetch.apply(window, args);
    captureResponse(requestInfo, response.clone());
    return response;
  };

  XMLHttpRequest.prototype.open = function open(method, url) {
    this.__tableExtractRequest = {
      method: method || "GET",
      url: new URL(url, location.href).href,
      headers: {}
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name, value) {
    if (this.__tableExtractRequest) {
      this.__tableExtractRequest.headers[name] = value;
    }

    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    if (this.__tableExtractRequest) {
      this.__tableExtractRequest.body = normalizeBody(body);
      this.addEventListener("load", () => {
        const responseText = readXhrResponseText(this);

        if (!responseText) {
          return;
        }

        postCapturedRequest({
          ...this.__tableExtractRequest,
          status: this.status,
          responseText
        });
      });
    }

    return originalSend.apply(this, arguments);
  };

  function captureFetchRequest(args) {
    const input = args[0];
    const init = args[1] || {};
    const url = input instanceof Request ? input.url : new URL(String(input), location.href).href;
    const method = init.method || (input instanceof Request ? input.method : "GET");
    const headers = headersToObject(init.headers || (input instanceof Request ? input.headers : undefined));

    return {
      method,
      url,
      headers,
      body: normalizeBody(init.body)
    };
  }

  async function captureResponse(requestInfo, response) {
    try {
      postCapturedRequest({
        ...requestInfo,
        status: response.status,
        responseText: await response.text()
      });
    } catch (error) {
      // Ignore unreadable response bodies.
    }
  }

  function postCapturedRequest(payload) {
    window.postMessage(
      {
        source: "TABLE_EXTRACT_NETWORK",
        payload
      },
      "*"
    );
  }

  function headersToObject(headers) {
    const result = {};

    if (!headers) {
      return result;
    }

    new Headers(headers).forEach((value, key) => {
      result[key] = value;
    });

    return result;
  }

  function normalizeBody(body) {
    if (typeof body === "string" || body == null) {
      return body || "";
    }

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    return "";
  }

  function readXhrResponseText(xhr) {
    try {
      if (!xhr.responseType || xhr.responseType === "text") {
        return xhr.responseText || "";
      }

      if (xhr.responseType === "json") {
        return JSON.stringify(xhr.response);
      }
    } catch (error) {
      return "";
    }

    return "";
  }
})();
