import { useEffect, useMemo, useState } from "react";
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { db, auth } from "../firebase";

const PARTICIPANTS = [
  "Graciele",
  "Daniel",
  "Jeisiele",
  "Maria aparecida",
  "Lucas",
  "Adrieli",
  "Marcilene",
  "Danilo",
  "Eva Maria",
  "Jonatas",
  "Luana",
  "Cleselene",
  "Gabriel",
  "asafe",
];

const FIXED_A = "Daniel";
const FIXED_B = "Graciele";

function slugName(name) {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDerangement(names) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const perm = shuffle(names);
    let ok = true;
    for (let i = 0; i < names.length; i++) {
      if (perm[i] === names[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return perm;
  }
  return null;
}

function buildAssignments() {
  const all = [...PARTICIPANTS];
  const others = all.filter((n) => n !== FIXED_A && n !== FIXED_B);

  const perm = makeDerangement(others);
  if (!perm) throw new Error("Não foi possível gerar um sorteio válido.");

  const map = {};
  map[FIXED_A] = FIXED_B;
  map[FIXED_B] = FIXED_A;

  for (let i = 0; i < others.length; i++) {
    map[others[i]] = perm[i];
  }
  return map;
}

export default function AmigoSecreto() {
  const [uid, setUid] = useState(null);

  const [me, setMe] = useState("");
  const [lockedMe, setLockedMe] = useState(""); // nome travado no dispositivo

  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);

  const options = useMemo(
    () => [...PARTICIPANTS].sort((a, b) => a.localeCompare(b)),
    []
  );

  // 1) garante auth anônimo e pega uid
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (u) {
          setUid(u.uid);
          await loadLockedIdentity(u.uid);
          return;
        }
        const res = await signInAnonymously(auth);
        setUid(res.user.uid);
        await loadLockedIdentity(res.user.uid);
      } catch (e) {
        setErr(e?.message || "Falha ao autenticar no Firebase.");
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLockedIdentity(currentUid) {
    // se já escolheu antes, trava ao carregar (mesmo com F5)
    const userRef = doc(db, "users", currentUid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      const pickedId = userSnap.data()?.pickedParticipantId;
      if (pickedId) {
        const foundName =
          PARTICIPANTS.find((p) => slugName(p) === pickedId) || "";
        if (foundName) {
          setLockedMe(foundName);
          setMe(foundName);
        }
      }
    }
  }

  // 2) trava: um uid só pode escolher 1 nome e cada nome só pode ser escolhido 1 vez
  async function lockIdentity(selectedName) {
    if (!uid) throw new Error("Aguardando autenticação...");

    const participantId = slugName(selectedName);
    const userRef = doc(db, "users", uid);
    const claimRef = doc(db, "claims", participantId);

    await runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      const claimSnap = await tx.get(claimRef);

      // este dispositivo já escolheu alguém?
      if (userSnap.exists()) {
        const already = userSnap.data()?.pickedParticipantId;
        if (already && already !== participantId) {
          throw new Error(
            "Este dispositivo já escolheu um nome. Você não pode trocar."
          );
        }
      }

      // este nome já foi escolhido por outra pessoa?
      if (claimSnap.exists()) {
        const who = claimSnap.data()?.claimedByUid;
        if (who !== uid) {
          throw new Error("Este nome já foi escolhido por outra pessoa.");
        }
      }

      // escreve user (uma vez)
      if (!userSnap.exists()) {
        tx.set(userRef, {
          pickedParticipantId: participantId,
          pickedAt: serverTimestamp(),
        });
      }

      // escreve claim (uma vez)
      if (!claimSnap.exists()) {
        tx.set(claimRef, {
          participantName: selectedName,
          claimedByUid: uid,
          claimedAt: serverTimestamp(),
        });
      }
    });

    setLockedMe(selectedName);
    setMe(selectedName);
  }

  // 3) cria o sorteio (se não existir) e retorna o meu
  async function ensureDrawAndGetMine(name) {
    const metaRef = doc(db, "draws", "current");
    const myRef = doc(db, "draw_assignments", slugName(name));

    const mySnap = await getDoc(myRef);
    if (mySnap.exists()) return mySnap.data();

    return runTransaction(db, async (tx) => {
      const metaSnap = await tx.get(metaRef);

      if (metaSnap.exists() && metaSnap.data()?.locked) {
        const again = await tx.get(myRef);
        if (again.exists()) return again.data();
        throw new Error("Sorteio existe, mas seu registro não foi encontrado.");
      }

      const assignments = buildAssignments();

      tx.set(
        metaRef,
        { locked: true, createdAt: serverTimestamp() },
        { merge: true }
      );

      for (const person of PARTICIPANTS) {
        tx.set(doc(db, "draw_assignments", slugName(person)), {
          name: person,
          assignedTo: assignments[person],
          drawnAt: serverTimestamp(),
        });
      }

      return {
        name,
        assignedTo: assignments[name],
        drawnAt: new Date(),
      };
    });
  }

  async function handleDraw() {
    setErr("");
    setResult("");
    setCopied(false);

    if (!me) {
      setErr("Selecione seu nome para continuar.");
      return;
    }

    try {
      setLoading(true);

      // trava identidade antes do sorteio
      if (!lockedMe) {
        await lockIdentity(me);
      } else if (lockedMe !== me) {
        // se alguém tentar mexer no select via devtools
        throw new Error("Seu nome já está definido. Não é possível alterar.");
      }

      const mine = await ensureDrawAndGetMine(me);
      setResult(mine?.assignedTo || "");
      setShowModal(true);
    } catch (e) {
      setErr(e.message || "Erro ao sortear.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="as-page">
      <div className="as-bg" />

      <div className="as-wrap">
        <header className="as-header">
          <div className="as-badge">🎁</div>
          <div>
            <h1 className="as-title">Amigo Secreto</h1>
            <p className="as-subtitle">
              Escolha seu nome e clique em <b>Sortear</b>. O resultado fica salvo
              e não repete.
            </p>
          </div>
        </header>

        <div className="as-card">
          <div className="as-field">
            <label>Quem é você?</label>
            <select
              value={me}
              onChange={(e) => setMe(e.target.value)}
              disabled={!!lockedMe} // trava no front também
            >
              <option value="">Selecione…</option>
              {options.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            {lockedMe && (
              <div className="as-hint" style={{ marginTop: 8 }}>
                ✅ Seu nome já foi definido como <b>{lockedMe}</b>.
              </div>
            )}
          </div>

          {err && <div className="as-alert as-alert-error">{err}</div>}

          <button className="as-btn" onClick={handleDraw} disabled={loading || !uid}>
            {loading ? "Sorteando..." : "Sortear agora"}
          </button>

          <p className="as-hint">
            Dica: após ver o resultado, <b>não revele</b> para ninguém 😉
          </p>
        </div>
      </div>

      {showModal && (
        <>
          <div
            className="as-modal-backdrop"
            onClick={() => setShowModal(false)}
          />
          <div className="as-modal" role="dialog" aria-modal="true">
            <div className="as-modal-top">
              <div>
                <h3>Seu amigo secreto é</h3>
                <p className="as-modal-sub">Guarde isso com você.</p>
              </div>
              <button
                className="as-x"
                onClick={() => setShowModal(false)}
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>

            <div className="as-result">
              <div className="as-result-pill">{result}</div>

              <button className="as-btn as-btn-secondary" onClick={handleCopy}>
                {copied ? "Copiado ✅" : "Copiar"}
              </button>
            </div>

            <div className="as-modal-actions">
              <button className="as-btn" onClick={() => setShowModal(false)}>
                Entendi
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
