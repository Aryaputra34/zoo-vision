#pragma once

#include "dataType.h"

// Magnet: nested in namespace bytetrack (see STrack.h).
namespace bytetrack {
namespace byte_kalman
{
	class KalmanFilter
	{
	public:
		KalmanFilter();
		KAL_DATA initiate(const DETECTBOX& measurement);
		void predict(KAL_MEAN& mean, KAL_COVA& covariance);
		KAL_HDATA project(const KAL_MEAN& mean, const KAL_COVA& covariance);
		KAL_DATA update(const KAL_MEAN& mean,
			const KAL_COVA& covariance,
			const DETECTBOX& measurement);

		// Magnet: gating_distance() and chi2inv95 removed. ByteTrack never calls them, and
		// gating_distance() called exit(0) on one path, which would take down the mediaserver.

	private:
		Eigen::Matrix<float, 8, 8, Eigen::RowMajor> _motion_mat;
		Eigen::Matrix<float, 4, 8, Eigen::RowMajor> _update_mat;
		float _std_weight_position;
		float _std_weight_velocity;
	};
}
} // namespace bytetrack