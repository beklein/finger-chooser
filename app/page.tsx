"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

const COUNTDOWN_MS = 3_000
const RESULT_MS = 2_200
const COOLDOWN_MS = 5_000
const WINNER_LINGER_MS = 1_200

const FINGER_HUES = [12, 42, 84, 132, 182, 216, 262, 304]

type Phase = "idle" | "countdown" | "winner" | "cooldown"

type TouchPoint = {
  id: number
  x: number
  y: number
  hue: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function hueForPointer(pointerId: number) {
  return FINGER_HUES[Math.abs(pointerId) % FINGER_HUES.length]
}

function hslWithAlpha(hue: number, alpha: number) {
  return `hsl(${hue} 88% 60% / ${alpha})`
}

function countdownPulsePhase(progress: number) {
  return 1.6 * progress + 4.4 * progress * progress
}

function countdownPulseScale(progress: number) {
  const easedProgress = 1 - (1 - progress) ** 3
  const wave = 0.5 + 0.5 * Math.sin(Math.PI * 2 * countdownPulsePhase(progress))
  const growth = 1 + 0.88 * easedProgress
  const amplitude = 0.05 + 0.07 * easedProgress
  return Math.min(2, growth + wave * amplitude)
}

function getMultiTouchSnapshot() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return true
  }

  return "PointerEvent" in window && navigator.maxTouchPoints >= 2
}

function getDesktopSnapshot() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false
  }

  const desktopPointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches
  return desktopPointer && navigator.maxTouchPoints < 2
}

function subscribeToViewportChange(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {}
  }

  window.addEventListener("resize", onStoreChange)
  window.addEventListener("orientationchange", onStoreChange)

  return () => {
    window.removeEventListener("resize", onStoreChange)
    window.removeEventListener("orientationchange", onStoreChange)
  }
}

function subscribeToNoop() {
  return () => {}
}

function HelpContent() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
      <div>
        <h3 className="text-sm font-semibold text-foreground">How it works</h3>
        <p>Place two or more fingers in the touch area and hold still.</p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Round flow</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Countdown starts automatically at 3 seconds.</li>
          <li>Adding a new finger resets the countdown to 3.</li>
          <li>One active finger is picked randomly when countdown ends.</li>
          <li>The winner lingers while cooldown runs.</li>
          <li>After cooldown, next round starts automatically with 2+ fingers.</li>
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Notes</h3>
        <p>
          If touches drop below two before the countdown finishes, the round cancels. Best experience is on modern
          mobile browsers with reliable multi-touch support.
        </p>
      </div>
    </div>
  )
}

export default function Page() {
  const areaRef = useRef<HTMLDivElement>(null)

  const [phase, setPhase] = useState<Phase>("idle")
  const [activeTouches, setActiveTouches] = useState<TouchPoint[]>([])
  const [resultTouches, setResultTouches] = useState<TouchPoint[]>([])
  const [winnerId, setWinnerId] = useState<number | null>(null)
  const [winnerLingering, setWinnerLingering] = useState(false)
  const [countdownSeconds, setCountdownSeconds] = useState(3)
  const [countdownProgress, setCountdownProgress] = useState(0)
  const [cooldownSeconds, setCooldownSeconds] = useState(5)

  const supportsMultiTouch = useSyncExternalStore(subscribeToNoop, getMultiTouchSnapshot, () => true)
  const isDesktop = useSyncExternalStore(subscribeToViewportChange, getDesktopSnapshot, () => false)

  const phaseRef = useRef<Phase>("idle")
  const touchesRef = useRef<Map<number, TouchPoint>>(new Map())
  const roundTokenRef = useRef(0)

  const countdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cooldownTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const winnerLingerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownStartRef = useRef<number | null>(null)
  const countdownAnimationFrameRef = useRef<number | null>(null)
  const lastHapticPulseRef = useRef(-1)

  const isResultPhase = phase === "winner" || phase === "cooldown"

  const displayedTouches = useMemo(() => {
    if (phase === "winner") {
      return resultTouches
    }

    if (phase === "cooldown") {
      return resultTouches.filter((point) => point.id === winnerId)
    }

    if (winnerLingering && winnerId !== null) {
      return resultTouches.filter((point) => point.id === winnerId)
    }

    return activeTouches
  }, [activeTouches, phase, resultTouches, winnerId, winnerLingering])

  function setPhaseSafely(nextPhase: Phase) {
    phaseRef.current = nextPhase
    setPhase(nextPhase)
  }

  function syncTouches(nextTouches: Map<number, TouchPoint>) {
    touchesRef.current = nextTouches
    setActiveTouches(Array.from(nextTouches.values()))
  }

  function clearWinnerLingerTimer() {
    if (winnerLingerTimeoutRef.current) {
      clearTimeout(winnerLingerTimeoutRef.current)
      winnerLingerTimeoutRef.current = null
    }
  }

  function triggerCountdownHaptic(progress: number) {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return
    }

    const pulseIndex = Math.floor(countdownPulsePhase(progress))

    if (pulseIndex > lastHapticPulseRef.current) {
      const vibrationMs = Math.round(10 + progress * 14)
      navigator.vibrate(vibrationMs)
      lastHapticPulseRef.current = pulseIndex
    }
  }

  function clearCountdownAnimation() {
    if (countdownAnimationFrameRef.current !== null) {
      cancelAnimationFrame(countdownAnimationFrameRef.current)
      countdownAnimationFrameRef.current = null
    }

    countdownStartRef.current = null
    lastHapticPulseRef.current = -1

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(0)
    }
  }

  function startCountdownAnimation(token: number) {
    countdownStartRef.current = performance.now()
    lastHapticPulseRef.current = -1
    setCountdownProgress(0)

    const animate = () => {
      if (phaseRef.current !== "countdown" || roundTokenRef.current !== token || countdownStartRef.current === null) {
        return
      }

      const progress = clamp((performance.now() - countdownStartRef.current) / COUNTDOWN_MS, 0, 1)
      setCountdownProgress(progress)
      triggerCountdownHaptic(progress)

      if (progress < 1) {
        countdownAnimationFrameRef.current = requestAnimationFrame(animate)
      }
    }

    countdownAnimationFrameRef.current = requestAnimationFrame(animate)
  }

  function clearCountdownTimers() {
    if (countdownTimeoutRef.current) {
      clearTimeout(countdownTimeoutRef.current)
      countdownTimeoutRef.current = null
    }

    if (countdownTickRef.current) {
      clearInterval(countdownTickRef.current)
      countdownTickRef.current = null
    }

    clearCountdownAnimation()
  }

  function clearCooldownTimers() {
    if (resultTimeoutRef.current) {
      clearTimeout(resultTimeoutRef.current)
      resultTimeoutRef.current = null
    }

    if (cooldownTimeoutRef.current) {
      clearTimeout(cooldownTimeoutRef.current)
      cooldownTimeoutRef.current = null
    }

    if (cooldownTickRef.current) {
      clearInterval(cooldownTickRef.current)
      cooldownTickRef.current = null
    }
  }

  function resetWinnerDisplay() {
    clearWinnerLingerTimer()
    setWinnerLingering(false)
    setWinnerId(null)
    setResultTouches([])
  }

  function cancelToIdle() {
    clearCountdownTimers()
    setCountdownSeconds(3)

    if (phaseRef.current === "countdown") {
      setPhaseSafely("idle")
    }
  }

  function startCountdown() {
    if (!getMultiTouchSnapshot() || isDesktop) {
      return
    }

    if (touchesRef.current.size < 2) {
      return
    }

    clearWinnerLingerTimer()
    setWinnerLingering(false)

    if (phaseRef.current !== "winner" && phaseRef.current !== "cooldown") {
      setWinnerId(null)
      setResultTouches([])
    }

    clearCountdownTimers()
    setPhaseSafely("countdown")
    setCountdownSeconds(3)

    const token = roundTokenRef.current + 1
    roundTokenRef.current = token
    startCountdownAnimation(token)

    countdownTickRef.current = setInterval(() => {
      setCountdownSeconds((current) => Math.max(1, current - 1))
    }, 1_000)

    countdownTimeoutRef.current = setTimeout(() => {
      if (roundTokenRef.current !== token || phaseRef.current !== "countdown") {
        return
      }

      const ids = Array.from(touchesRef.current.keys())

      if (ids.length < 2) {
        cancelToIdle()
        return
      }

      const selectedId = ids[Math.floor(Math.random() * ids.length)]
      const snapshot = Array.from(touchesRef.current.values())

      clearCountdownTimers()
      setResultTouches(snapshot)
      setWinnerId(selectedId)
      setPhaseSafely("winner")

      resultTimeoutRef.current = setTimeout(() => {
        if (phaseRef.current !== "winner") {
          return
        }

        setPhaseSafely("cooldown")
        setCooldownSeconds(5)

        cooldownTickRef.current = setInterval(() => {
          setCooldownSeconds((current) => Math.max(1, current - 1))
        }, 1_000)

        cooldownTimeoutRef.current = setTimeout(() => {
          clearCooldownTimers()
          setPhaseSafely("idle")
          setWinnerLingering(true)

          clearWinnerLingerTimer()
          winnerLingerTimeoutRef.current = setTimeout(() => {
            resetWinnerDisplay()
          }, WINNER_LINGER_MS)

          if (touchesRef.current.size >= 2 && getMultiTouchSnapshot() && !isDesktop) {
            startCountdown()
          }
        }, COOLDOWN_MS)
      }, RESULT_MS)
    }, COUNTDOWN_MS)
  }

  function updateTouch(pointerId: number, clientX: number, clientY: number) {
    const area = areaRef.current

    if (!area || isDesktop) {
      return
    }

    const rect = area.getBoundingClientRect()
    const x = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100)
    const y = clamp(((clientY - rect.top) / rect.height) * 100, 0, 100)

    const nextTouches = new Map(touchesRef.current)
    const existing = nextTouches.get(pointerId)

    nextTouches.set(pointerId, {
      id: pointerId,
      x,
      y,
      hue: existing?.hue ?? hueForPointer(pointerId),
    })

    const previousSize = touchesRef.current.size
    const nextSize = nextTouches.size

    syncTouches(nextTouches)

    if (phaseRef.current === "countdown" && nextSize > previousSize && nextSize >= 2) {
      startCountdown()
      return
    }

    if (phaseRef.current === "idle" && nextSize >= 2) {
      startCountdown()
    }
  }

  function removeTouch(pointerId: number) {
    if (!touchesRef.current.has(pointerId)) {
      return
    }

    const nextTouches = new Map(touchesRef.current)
    nextTouches.delete(pointerId)
    syncTouches(nextTouches)

    if (phaseRef.current === "countdown" && nextTouches.size < 2) {
      cancelToIdle()
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || isDesktop) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateTouch(event.pointerId, event.clientX, event.clientY)
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || isDesktop) {
      return
    }

    if (!touchesRef.current.has(event.pointerId)) {
      return
    }

    event.preventDefault()
    updateTouch(event.pointerId, event.clientX, event.clientY)
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return
    }

    removeTouch(event.pointerId)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      return
    }

    removeTouch(event.pointerId)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  useEffect(() => {
    function cancelCountdownFromInterrupt() {
      if (phaseRef.current !== "countdown") {
        return
      }

      clearCountdownTimers()
      setCountdownSeconds(3)
      setPhaseSafely("idle")
    }

    function handleResize() {
      cancelCountdownFromInterrupt()
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        cancelCountdownFromInterrupt()
      }
    }

    window.addEventListener("resize", handleResize)
    window.addEventListener("orientationchange", handleResize)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("orientationchange", handleResize)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
    // This effect intentionally subscribes once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      clearCountdownTimers()
      clearCooldownTimers()
      clearWinnerLingerTimer()
    }
    // This effect intentionally runs only for unmount cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusLabel =
    phase === "idle"
      ? "Hold 2+ fingers to start."
      : phase === "countdown"
        ? `Choosing winner in ${countdownSeconds} sec`
        : phase === "winner"
          ? "Winner selected"
          : `Next round in ${cooldownSeconds} sec`
  const syncedCountdownScale = phase === "countdown" ? countdownPulseScale(countdownProgress) : 1
  const winnerFinalScale = countdownPulseScale(1)

  return (
    <main className="no-touch-select relative h-svh w-full overflow-hidden bg-[radial-gradient(circle_at_top,_color-mix(in_oklch,var(--primary)_14%,transparent)_0%,transparent_58%),linear-gradient(180deg,var(--background),color-mix(in_oklch,var(--background)_88%,var(--primary)_12%))]">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="Open help"
            className="absolute top-4 right-4 z-50 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/88 text-lg font-semibold text-foreground shadow-md backdrop-blur-sm"
          >
            ?
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[82svh] max-w-[min(92vw,34rem)] overflow-y-auto p-5">
          <DialogHeader>
            <DialogTitle>Finger Chooser</DialogTitle>
            <DialogDescription>
              One touch screen, two or more fingers, one random winner after a 3-second countdown.
            </DialogDescription>
          </DialogHeader>
          <HelpContent />
        </DialogContent>
      </Dialog>

      {isDesktop ? (
        <section className="no-touch-select absolute inset-0 flex items-center justify-center p-6">
          <div className="mx-auto w-full max-w-xl rounded-3xl border border-border/70 bg-card/92 p-6 shadow-xl backdrop-blur-sm sm:p-8">
            <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-border/80 bg-background text-lg font-semibold">
              ?
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Mobile App Experience</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Finger Chooser is built for touch devices. Open this page on a phone or tablet, place two or more fingers
              on the screen, and the app picks one winner after 3 seconds.
            </p>
            <div className="mt-5 rounded-2xl border border-border/60 bg-background/70 p-4">
              <HelpContent />
            </div>
          </div>
        </section>
      ) : (
        <section
          ref={areaRef}
          className="no-touch-select relative h-full w-full touch-none overflow-hidden"
          aria-label="Touch area"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,color-mix(in_oklch,var(--primary)_11%,transparent),transparent_68%)]" />

          {!supportsMultiTouch ? (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6 text-center">
              <p className="max-w-md rounded-2xl border border-destructive/40 bg-background/86 px-4 py-3 text-sm leading-relaxed text-muted-foreground backdrop-blur-sm">
                Reliable multi-touch is required for this experience. Please use a modern touch device with at least two
                simultaneous touch points.
              </p>
            </div>
          ) : null}

          {displayedTouches.map((point) => {
            const isWinner = winnerId === point.id
            const showResultStyle = isResultPhase || winnerLingering

            const contactBaseSize = isWinner && showResultStyle ? 130 : 110
            const centerBaseSize = isWinner && showResultStyle ? 92 : 74
            const pointScale =
              phase === "countdown" ? syncedCountdownScale : showResultStyle && isWinner ? winnerFinalScale : 1
            const contactSize = contactBaseSize * pointScale
            const centerSize = centerBaseSize * pointScale

            return (
              <div
                key={point.id}
                className={cn(
                  "pointer-events-none absolute will-change-transform",
                  phase === "winner" && !isWinner && "touch-loser-fade"
                )}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
              >
                <span
                  className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    width: `${contactSize}px`,
                    height: `${contactSize}px`,
                    background: `radial-gradient(circle, ${hslWithAlpha(point.hue, 0.5)} 0%, ${hslWithAlpha(point.hue, 0.2)} 44%, ${hslWithAlpha(point.hue, 0)} 76%)`,
                  }}
                />

                <div
                  className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                  style={{
                    width: `${centerSize}px`,
                    height: `${centerSize}px`,
                    borderColor: hslWithAlpha(point.hue, showResultStyle && isWinner ? 0.92 : 0.7),
                    backgroundColor: hslWithAlpha(point.hue, showResultStyle && isWinner ? 0.56 : 0.36),
                    boxShadow: `0 0 0 2px ${hslWithAlpha(point.hue, 0.3)}, 0 4px 10px ${hslWithAlpha(point.hue, 0.26)}`,
                  }}
                />
              </div>
            )
          })}

          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center px-4">
            <div className="rounded-full border border-border/70 bg-background/88 px-4 py-2 text-sm font-semibold tracking-wide text-foreground shadow-md backdrop-blur-sm">
              {statusLabel}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}
