# Progetto: Yu-Gi-Oh! Playmat Tracker (web)

## Obiettivo
Ricreare sul computer le carte Yu-Gi-Oh! fisiche posizionate su un tappetino, in stile Master Duel, ma senza duello né componente competitiva online. È una visualizzazione personale: una webcam inquadra il tappetino dall'alto, il sito riconosce le carte e mostra a schermo una rappresentazione digitale allineata a ciascuna carta reale.

## Comportamento desiderato
- Ogni carta sul tappetino viene rilevata, identificata e seguita nel tempo (tracking).
- Per i mostri con un modello 3D disponibile (glTF), si mostra il modello animato.
- Per tutte le altre carte, l'artwork in alta definizione è ben visibile sopra la carta, al posto del modello 3D.
- Effetti extra: cornice colorata per tipo di carta (mostri, magie, trappole), shader olografico/shimmer, statistiche fluttuanti (ATK/DEF, attributo, livello), parallasse 2.5D tramite depth map sull'artwork.
- La rotazione di 90° indica la posizione di difesa; le carte coperte si riconoscono dal dorso e vengono mostrate come tali.

## Decisioni già prese
- Si realizza come **sito web**, non con Unreal Engine: priorità a iterazione rapida e risultati visibili subito.
- Architettura di partenza: **tutto nel browser** (nessun server). Se l'identificazione nel browser si rivela troppo limitata, si passa a browser + backend Python (FastAPI, OpenCV, PyTorch/YOLO) via WebSocket, senza buttare il lato grafico.
- Unreal Engine resta un'opzione futura solo per la qualità visiva.

## Stack
- Vite + TypeScript
- Three.js (oppure React Three Fiber) per il rendering
- `getUserMedia` per la webcam
- OpenCV.js per contorni e omografia (4 angoli della carta, proporzioni note)
- ONNX Runtime Web o Transformers.js per embedding visivi (CLIP/DINOv2) con confronto contro gli embedding pre-calcolati del database
- Immagini e dati delle carte da YGOPRODeck, scaricati in locale una volta sola
- Depth Anything (o simili) per la depth map, calcolata offline in batch

## Scelte tecniche da rispettare
- Identificazione tramite confronto dell'artwork ritagliato con il database, non OCR del nome (fragile con carte olografiche e riflessi). Alternativa: codice del set, ma richiede camera ad alta risoluzione.
- L'identificazione si esegue solo quando compare una carta nuova; poi si fa tracking frame dopo frame, per evitare sfarfallii e gestire le occlusioni della mano.
- Il modello di embedding non deve girare a ogni frame.
- Modelli 3D generati da image-to-3D (TRELLIS, Hunyuan3D, Tripo, Meshy) solo offline, in batch, per i mostri scelti: sono privi di rig e animazioni e di qualità variabile.
- Hardware: camera fissa 1080p o 4K, cenitale, luce diffusa (i riflessi sulle olografiche sono il nemico principale).

## Ordine di sviluppo (ogni passo deve dare qualcosa di visibile)
1. Pagina con webcam e `<canvas>` sovrapposto
2. Rilevamento di un rettangolo con proporzioni da carta e riquadro che lo segue
3. Artwork di una carta scelta a mano in Three.js, allineato alla carta reale con omografia
4. Identificazione automatica
5. Shader olografico, parallasse con depth map, statistiche, modelli 3D

## Vincoli e note
- Uso personale: artwork e dati sono di Konami. Estrarre modelli da Master Duel viola ToS e diritti, quindi evitare o limitare a uso strettamente privato. Se il sito verrà mai pubblicato, valutare le questioni di copyright.
- Alcuni riferimenti emersi nella chat (progetto DRAW 2, SuperZouloux) non sono verificati: vanno controllati prima di farci affidamento.

## Su chi scrive
Sviluppatore con esperienza in C++, C#, JavaScript/Node.js e Unreal Engine. Preferisce vedere risultati in fretta e prototipi funzionanti. Rispondi in italiano, con codice completo e testabile, un passo alla volta.
