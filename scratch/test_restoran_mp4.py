import os
import cv2
import time
from ultralytics import YOLO
import supervision as sv

def main():
    video_path = r"C:\Users\Magnet Busdev-2\Downloads\restoran.mp4"
    out_dir = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch"
    os.makedirs(out_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    
    target_sec = 26 * 60 + 53
    target_frame = int(target_sec * fps)
    
    print(f"Seeking to {target_sec}s (Frame #{target_frame}) at {fps:.2f} FPS in {video_path}...")
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()
    
    if not ret or frame is None:
        print("Failed to read frame from restoran.mp4!")
        return
        
    print(f"Frame extracted! Resolution: {frame.shape[1]}x{frame.shape[0]}")
    raw_path = os.path.join(out_dir, "restoran_26_53_raw.jpg")
    cv2.imwrite(raw_path, frame)
    print(f"Saved raw 1080p frame to {raw_path}")
    
    # Run YOLO26s and YOLO26m on this raw 1080p frame
    for m_name in ["yolo26s.pt", "yolo26m.pt"]:
        model = YOLO(m_name)
        for imgsz in [1280, 1920]:
            t0 = time.time()
            res = model(frame, classes=[0], conf=0.20, imgsz=imgsz, verbose=False)[0]
            elapsed = (time.time() - t0) * 1000
            dets = sv.Detections.from_ultralytics(res)
            print(f"Model: {m_name:<10} | imgsz: {imgsz:<5} | Detections: {len(dets):<3} | Latency: {elapsed:.0f} ms | Mean Conf: {dets.confidence.mean():.2f}")
            
            box_ann = sv.BoxAnnotator(thickness=2)
            lbl_ann = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
            
            annotated = box_ann.annotate(frame.copy(), detections=dets)
            labels = [f"person {c:.2f}" for c in dets.confidence]
            annotated = lbl_ann.annotate(annotated, detections=dets, labels=labels)
            
            out_file = os.path.join(out_dir, f"restoran_26_53_{m_name.split('.')[0]}_{imgsz}.jpg")
            cv2.imwrite(out_file, annotated)
            print(f"Saved annotated preview: {out_file}")

if __name__ == "__main__":
    main()
