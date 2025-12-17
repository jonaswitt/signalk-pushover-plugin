import { useState, useEffect } from "react";

// Define the paths we care about
const PATHS = [
  "navigation.position",
  "navigation.anchor.position",
  "navigation.anchor.maxRadius",
  "navigation.anchor.bearingTrue",
  "navigation.anchor.currentRadius",
  "notifications.navigation.anchor",
] as const;

type PathKey = (typeof PATHS)[number];

type ValueState =
  | { value: number | Record<string, unknown> | null; timestamp: number | null }
  | undefined;

type AllValuesState = {
  [K in PathKey]?: ValueState;
};

function App() {
  const [allValues, setAllValues] = useState<AllValuesState>({});
  const [, setNow] = useState(Date.now()); // dummy state to force re-render
  const [isSendingTestPush, setIsSendingTestPush] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const wsUrl = `${
      import.meta.env.MODE === "development"
        ? "ws://192.168.2.11:3001"
        : window.location.origin.replace(/^http/, "ws")
    }/signalk/v1/stream?subscribe=none`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          context: "*",
          unsubscribe: [{ path: "*" }],
        })
      );
      ws.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: PATHS.map((path) => ({ path })),
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.updates && Array.isArray(data.updates)) {
          setAllValues((prev) => {
            const updated: AllValuesState = { ...prev };
            for (const update of data.updates) {
              if (update.values) {
                for (const value of update.values) {
                  if (PATHS.includes(value.path)) {
                    updated[value.path as PathKey] = {
                      value: value.value,
                      timestamp: Date.now(),
                    };
                  }
                }
              }
            }
            return updated;
          });
        }
      } catch {
        // Ignore parse errors
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const isStateKnown =
    allValues["notifications.navigation.anchor"]?.value !== undefined;
  const isStateOld =
    allValues["notifications.navigation.anchor"]?.timestamp == null ||
    Date.now() - allValues["notifications.navigation.anchor"]?.timestamp >
      1000 * 60;

  const alarmState =
    (
      allValues["notifications.navigation.anchor"]?.value as Record<
        string,
        string
      >
    )?.state ?? "normal";
  const isAlarm = ["emergency", "alarm"].includes(alarmState);

  const isAnchorUp = allValues["navigation.anchor.position"]?.value === null;

  const anchorRange = allValues["navigation.anchor.currentRadius"]?.value as
    | number
    | null
    | undefined;

  const anchorMaxRange = allValues["navigation.anchor.maxRadius"]?.value as
    | number
    | null
    | undefined;

  const anchorBearing = allValues["navigation.anchor.bearingTrue"]?.value as
    | number
    | null
    | undefined;

  const commonDivStyle = "font-bold text-2xl p-8 rounded-lg text-center m-8";

  return (
    <div>
      {(() => {
        if (!isStateKnown || isStateOld) {
          return (
            <div className={`${commonDivStyle} bg-gray-400 text-white`}>
              Waiting for Anchor State…
            </div>
          );
        }
        if (isAnchorUp) {
          return (
            <div className={`${commonDivStyle} bg-yellow-400 text-gray-700`}>
              Anchor Up
            </div>
          );
        }
        const range = (
          <>
            {anchorRange?.toFixed(0)} m @{" "}
            {anchorBearing != null
              ? ((anchorBearing * 180) / Math.PI).toFixed(0)
              : "?"}
            ° <br />
            (Max {anchorMaxRange?.toFixed(0)} m)
          </>
        );

        if (isAlarm) {
          return (
            <div className={`${commonDivStyle} bg-red-700 text-white`}>
              ALARM <br />
              {range}
            </div>
          );
        }
        return (
          <div className={`${commonDivStyle} bg-green-700 text-white`}>
            Anchor Set <br />
            {range}
          </div>
        );
      })()}

      <div className="flex justify-center">
        <button
          onClick={async () => {
            setIsSendingTestPush(true);
            try {
              const url = `${
                import.meta.env.MODE === "development"
                  ? "http://192.168.2.11:3001/"
                  : "/"
              }plugins/signalk-pushover-plugin/test`;
              const res = await fetch(url, { method: "POST" });
              if (!res.ok) {
                alert(
                  `Failed to send push notification: HTTP ${res.status} ${res.statusText}`
                );
                return;
              }
              const data = await res.json();
              console.log(data);
            } finally {
              setIsSendingTestPush(false);
            }
          }}
          className="bg-blue-500 text-white p-2 rounded-md hover:bg-blue-600 transition-colors "
          disabled={isSendingTestPush}
        >
          {isSendingTestPush ? "Sending…" : "Send Test Push Notification"}
        </button>
      </div>
    </div>
  );
}

export default App;
