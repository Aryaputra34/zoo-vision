import os
import cv2
import time
from ultralytics import YOLO
import supervision as sv

def main():
    video_path = r"C:\Users\Magnet Busdev-2\Downloads\Copy of 27062026.mp4"
    out_dir = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch"
    os.makedirs(out_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    
    # 26:53 = 26 * 60 + 53 = 1613 seconds
    target_sec = 26 * 60 + 53
    target_frame = int(target_sec * fps)
    
    print(f"Seeking to {target_sec}s (Frame #{target_frame}) at {fps} FPS...")
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()
    
    if not ret or frame is None:
        print("Failed to read frame from video!")
        return
        
    print(f"Frame extracted! Shape: {frame.shape} (H, W, C)")
    raw_frame_path = os.path.join(out_dir, "raw_frame_26_53_1080p.jpg")
    cv2.imwrite(raw_frame_path, frame)
    print(f"Saved raw 1080p frame to {raw_frame_path}")
    
    # Run YOLO26s and YOLO26m on this true 1080p frame
    models = ["yolo26s.pt", "yolo26m.pt"]
    
    for m_name in models:
        yolo = YOLO(m_name)
        for imgsz in [1024, 1280]:
            t0 = time.time()
            res = yolo(frame, classes=[0], conf=0.20, imgsz=imgsz, verbose=False)[0]
            elapsed = (time.time() - t0) * 1000
            dets = sv.Detections.from_ultralytics(res)
            print(f"Model: {m_name:<10} | imgsz: {imgsz:<5} | Detections: {len(dets):<3} | Time: {elapsed:.0f} ms | Mean Conf: {dets.confidence.mean():.2f}")
            
            box_ann = sv.BoxAnnotator(thickness=2)
            lbl_ann = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
            
            annotated = box_ann.annotate(frame.copy(), detections=dets)
            labels = [f"person {c:.2f}" for c in dets.confidence]
            annotated = lbl_ann.annotate(annotated, detections=dets, labels=labels)
            
            out_file = os.path.join(out_dir, f"detected_1080p_{m_name.split('.')[0]}_{imgsz}.jpg")
            cv2.imwrite(out_file, annotated)
            print(f"Saved preview: {out_file}")

if __name__ == "__main__":
    main()
