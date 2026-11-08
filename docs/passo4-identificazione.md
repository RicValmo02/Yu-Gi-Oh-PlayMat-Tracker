# Passo 4 – identificazione automatica

## Modo facile: carica il tuo mazzo (.ydk)
1. `npm install && npm run dev`, poi **📂 Mazzo…** nella barra in alto.
2. Trascina il file `.ydk` (o «scegli file»), scegli quali sezioni includere (Main/Extra/Side) e premi **Scarica e prepara**.
3. Il browser chiede i dati con una sola richiesta all'API YGOPRODeck, scarica gli artwork *una volta sola* (pausa tra le
   richieste), calcola gli embedding con lo stesso modello dell'identificazione e salva tutto in IndexedDB: alla volta
   successiva il mazzo si riapre da solo, senza rete. Le carte del mazzo vengono usate anche per l'elenco di assegnazione manuale.
4. Con «Cerca solo tra le carte del mazzo» l'identificazione confronta ~40 candidati invece di migliaia: molto più precisa.
5. Dorso (opzionale): scegli un'immagine del tuo dorso nella finestra, oppure metti `public/cards/back.jpg`.

Il download passa dai proxy di Vite (`/ygo-api`, `/ygo-img`, in `vite.config.ts`): funziona con `npm run dev` e
`npm run preview`; un hosting statico senza proxy non li ha. `npm run cards` / `npm run embeddings` servono solo se vuoi il
database completo (modalità «tutto il database»).

## Modo database completo (opzionale)

### Setup
```bash
git pull && npm install
npm run cards        # scarica artwork (+ carta intera) e il dorso in public/cards/
npm run embeddings   # calcola public/embeddings/ (index.json + vectors-art.bin + vectors-full.bin)
npm run dev
```
1. **Prova con le 8 carte di test** (`cards.config.json` com'è): poche decine di secondi in tutto.
2. **Tutto il database**: in `cards.config.json` metti `"mode": "all"` e rilancia i due comandi.
   Il download è ripristinabile (Ctrl+C e rilancia: i file presenti si saltano). Con `delayMs: 300`
   servono ore per ~13.000 carte × 2 immagini; abbassa a 100 se vuoi (pausa minima 50 ms), oppure
   metti `"images": ["art"]` per scaricare solo gli artwork.
3. **Dorso**: `npm run cards` prova a scaricare `public/cards/back.jpg`; l'URL in config non è verificato.
   Se fallisce, metti tu una foto/scansione del dorso (o dei tuoi sleeve) come `public/cards/back*.jpg`
   (anche più file: `back-sleeve.jpg`, …) e rilancia `npm run embeddings`.

## Spazio e memoria (stime, verifica con `du -sh public/*`)
| Cosa | Dimensione |
|---|---|
| Modello DINOv2-small fp32 (scaricato dal browser una volta, poi in cache) | ~90 MB |
| Runtime ONNX Runtime Web (wasm) servito dal sito | ~28 MB |
| Immagini artwork, ~13.000 carte | ordine di 0,5–1 GB |
| Immagini carta intera, ~13.000 carte | ordine di 0,5–1 GB |
| `vectors-art.bin` / `vectors-full.bin` (384 byte per carta, int8) | ~5 MB ciascuno |
| RAM nel browser a database completo | ~5–10 MB di vettori + modello (~300–500 MB di RAM per la sessione ONNX) |

Tempo di `npm run embeddings` sull'intero database: indicativamente 5–15 minuti per modalità su CPU.

## Come funziona
- Raddrizzamento: `cv.warpPerspective` con i 4 angoli del tracker → immagine 421×614.
- La regione dell'illustrazione è definita **solo** in `src/cardGeometry.ts` (`ART_BOX_PX`).
- Modello: DINOv2-small (CLS token, 384 dimensioni), preprocessing in `src/preprocess.ts`
  (ritaglio, media ad area, normalizzazione ImageNet) condiviso tra browser e script.
- Per ogni carta nuova: N campioni a intervalli → media degli embedding → ricerca per prodotto scalare
  sia per l'immagine dritta sia per quella ruotata di 180°; vince il punteggio migliore (e imposta la rotazione).
- Stati: identificata / incerta (1° e 2° troppo vicini) / sconosciuta (sotto soglia) / coperta (miglior match = dorso).

## Valutare l'accuratezza
1. Prepara ~20 carte reali, di cui almeno 5 olografiche/rare, tutte presenti nel database scaricato.
2. Per ogni modalità (**Solo artwork** e **Carta intera**, menu nel pannello) metti ogni carta da sola sul
   tappetino, fai passare la valutazione (stato "identificata", 6 frame) e annota nome mostrato, punteggio e stato.
3. Ripeti con la carta ruotata di 90° e capovolta di 180° (controlla che l'artwork sia dritto).
4. Compila:

| # | Carta | Olografica | Modalità | Esito (ok / errata / incerta / sconosciuta) | Punteggio | Note |
|---|---|---|---|---|---|---|
| 1 | | no | art | | | |

5. Riassumi per modalità: % corrette, % incerte/sconosciute, % errate (le errate sono il caso grave). Regola la
   soglia (le errate con punteggio basso scompaiono alzandola) e il distacco 1°–2°.
