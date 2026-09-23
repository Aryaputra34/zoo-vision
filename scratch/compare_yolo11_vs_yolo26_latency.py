import os
import time
import cv2
import numpy as np
from ultralytics import YOLO
import supervision as sv

def benchmark_model(model_name, frame, imgsz=1280, conf=0.20, runs=3):
    print(f"\n--- Loading {model_name} (imgsz={imgsz}) ---")
    model = YOLO(model_name)
    
    # 1. Warmup pass
    _ = model(frame, classes=[0], conf=conf, imgsz=imgsz, verbose=False)
    
    # 2. Timed runs
    latencies = []
    res = None
    for _ in range(runs):
        t0 = time.perf_counter()
        res = model(frame, classes=[0], conf=conf, imgsz=imgsz, verbose=False)[0]
        t1 = time.perf_counter()
        latencies.append((t1 - t0) * 1000)
        
    avg_latency = float(np.mean(latencies))
    dets = sv.Detections.from_ultralytics(res)
    mean_conf = float(dets.confidence.mean()) if len(dets) > 0 else 0.0
    
    return {
        "model": model_name,
        "imgsz": imgsz,
        "count": len(dets),
        "mean_conf": mean_conf,
        "latency_ms": avg_latency
    }

def get_frame():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    if os.path.exists(img_path):
        f = cv2.imread(img_path)
        if f is not None:
            return f
            
    video_path = r"C:\Users\Magnet Busdev-2\Downloads\restoran.mp4"
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15.5
    target_frame = int((26 * 60 + 53) * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()
    if ret and frame is not None:
        cv2.imwrite(img_path, frame)
        return frame
    return None

def main():
    frame = get_frame()
    if frame is None:
        print("Failed to get 1080p frame from video!")
        return
        
    models_to_test = [
        # Small
        ("yolo11s.pt", 1280),
        ("yolo26s.pt", 1280),
        
        # Medium
        ("yolo11m.pt", 1280),
        ("yolo26m.pt", 1280),
        
        # Large
        ("yolo11l.pt", 1280),
        ("yolo26l.pt", 1280),
        
        # Native 1920 comparison for top contenders
        ("yolo11m.pt", 1920),
        ("yolo26m.pt", 1920),
        ("yolo11l.pt", 1920),
        ("yolo26l.pt", 1920),
    ]
    
    results = []
    for m, sz in models_to_test:
        r = benchmark_model(m, frame, imgsz=sz, conf=0.20, runs=3)
        results.append(r)
        print(f"--> {r['model']:<12} | imgsz: {r['imgsz']:<5} | Detections: {r['count']:<3} | Latency: {r['latency_ms']:.1f} ms | Conf: {r['mean_conf']:.2f}")

    print("\n\n=================== FINAL SUMMARY ===================")
    print(f"{'Model':<12} | {'imgsz':<6} | {'Count':<6} | {'Mean Conf':<10} | {'Latency (ms)':<12}")
    print("-" * 55)
    for r in results:
        print(f"{r['model']:<12} | {r['imgsz']:<6} | {r['count']:<6} | {r['mean_conf']:<10.2f} | {r['latency_ms']:<12.1f}")

if __name__ == "__main__":
    main()
