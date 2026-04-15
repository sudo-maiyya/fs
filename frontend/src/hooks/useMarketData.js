import { useState, useEffect } from "react";
import { generateChain, formatLiveChain } from "../utils/optionsLogic";
import { FP_SYMS, BASE_P } from "../utils/constants";

const BACKEND_URL = "http://103.168.18.1:5678"; // VPS Backend Link

export function useMarketData(paused) {
  const [spot, setSpot] = useState(22480);
  const [chainData, setChainData] = useState(() => generateChain(22480));
  const [availableSyms, setAvailableSyms] = useState(FP_SYMS);
  const [fpStates, setFpStates] = useState({});
  const [fpPrices, setFpPrices] = useState({ ...BASE_P });
  const [fpSignals, setFpSignals] = useState([]);
  const [mtfData, setMtfData] = useState({});
  const [cvd5m, setCvd5m] = useState({});
  const [cvd15m, setCvd15m] = useState({});
  const [cvd1h, setCvd1h] = useState({});
  const [zones, setZones] = useState({});
  const [selSym, setSelSym] = useState(FP_SYMS[0]);
  const [isOnline, setIsOnline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());

  useEffect(() => {
    if (paused) return;
    
    // 🛡️ THE FIX: Used to clean up memory and prevent React state updates on unmounted components
    let isMounted = true; 
    let timerId = null;

    const fetchData = async () => {
      try {
        // ==========================================================
        // 🚀 THE MEGA PAYLOAD FIX
        // Replaced 9 parallel API calls with 1 hyper-fast bulk fetch!
        // ==========================================================
        const response = await fetch(`${BACKEND_URL}/mega_payload`, { signal: AbortSignal.timeout(4000) });
        const megaData = await response.json();

        // Destructure the payload into the exact variables your UI expects
        const stateData = megaData.state;
        const sigData = megaData.signals;
        const zoneData = megaData.zones; 
        const spotData = megaData.spot;
        const mtfPayload = megaData.mtf;
        const c5Data = megaData.cvd_5m;
        const c15Data = megaData.cvd_15m;
        const c1hData = megaData.cvd_1h;
        const chainPayload = megaData.chain;

        if (!isMounted) return;

        setIsOnline(true);
        setLastUpdate(new Date());
        setSpot(spotData.spot);

        // 🛡️ THE FIX: Functional state update prevents stale closure blank-outs
        if (chainPayload && chainPayload.length > 0) {
            setChainData(formatLiveChain(chainPayload, spotData.spot));
        } else {
            setChainData(prev => prev.length === 0 ? generateChain(spotData.spot) : prev);
        }

        const stateArray = Object.values(stateData);

        if (stateArray.length > 0) {
          const newFpStates = {};
          const newFpPrices = {};
          const activeSyms = [];
          
          stateArray.forEach(st => {
            const sym = st.symbol; 
            activeSyms.push(sym);
            newFpPrices[sym] = st.ltp;
            newFpStates[sym] = st;
          });

          setFpStates(newFpStates);
          setFpPrices(newFpPrices);
          setFpSignals(sigData);
          setAvailableSyms(activeSyms);
          setZones(zoneData || {});
          setMtfData(mtfPayload || {});
          setCvd5m(c5Data || {});
          setCvd15m(c15Data || {});
          setCvd1h(c1hData || {});

          setSelSym((currentLiveSym) => {
              if (!activeSyms.includes(currentLiveSym) && activeSyms.length > 0) {
                  return activeSyms[0]; 
              }
              return currentLiveSym; 
          });
        }
      } catch (err) {
        if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
           console.error("Market Data Fetch Error:", err);
        }
        if (isMounted) setIsOnline(false);
      } finally {
        // 🛡️ THE FIX: Recursive Timeout Loop instead of overlapping setInterval
        // Guarantees perfectly smooth pacing regardless of network delays!
        if (isMounted && !paused) {
          timerId = setTimeout(fetchData, 800);
        }
      }
    };

    fetchData(); 

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
    };
    
  }, [paused]); 

  return {
    spot, chainData, availableSyms, fpStates, fpPrices, fpSignals, 
    mtfData, cvd5m, cvd15m, cvd1h, zones, selSym, setSelSym, isOnline, lastUpdate 
  };
}