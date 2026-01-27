<?php
/**
 * Shortcode Handler
 *
 * Registers and handles shortcodes for the Kelbe Project Tracker plugin.
 *
 * @package    Kelbe_Project_Tracker
 * @subpackage Kelbe_Project_Tracker/includes
 * @since      1.0.0
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
	die;
}

/**
 * Shortcode Handler Class
 *
 * @since 1.0.0
 */
class KPT_Shortcodes {

	/**
	 * The single instance of the class.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    KPT_Shortcodes
	 */
	protected static $instance = null;

	/**
	 * Main Instance
	 *
	 * Ensures only one instance of the class is loaded or can be loaded.
	 *
	 * @since  1.0.0
	 * @return KPT_Shortcodes - Main instance.
	 */
	public static function instance() {
		if ( is_null( self::$instance ) ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Constructor
	 *
	 * @since 1.0.0
	 */
	private function __construct() {
		$this->register_shortcodes();
	}

	/**
	 * Register shortcodes
	 *
	 * @since 1.0.0
	 */
	private function register_shortcodes() {
		add_shortcode( 'kpt_trade_portal', array( $this, 'render_trade_portal' ) );
		add_shortcode( 'kpt_client_portal', array( $this, 'render_client_portal' ) );
	}

	/**
	 * Render trade portal shortcode
	 *
	 * @since  1.0.0
	 * @param  array $atts Shortcode attributes.
	 * @return string Shortcode output.
	 */
	public function render_trade_portal( $atts ) {
		// Check if user is logged in.
		if ( ! is_user_logged_in() ) {
			return $this->render_login_message();
		}

		// Parse attributes.
		$atts = shortcode_atts(
			array(
				'title' => __( 'Team Portal', 'kelbe-project-tracker' ),
			),
			$atts,
			'kpt_trade_portal'
		);

		// Start output buffering.
		ob_start();

		// Load portal template.
		$this->load_portal_template( 'trade', $atts );

		// Return the output.
		return ob_get_clean();
	}

	/**
	 * Render client portal shortcode
	 *
	 * @since  1.0.0
	 * @param  array $atts Shortcode attributes.
	 * @return string Shortcode output.
	 */
	public function render_client_portal( $atts ) {
		// Check if user is logged in.
		if ( ! is_user_logged_in() ) {
			return $this->render_login_message();
		}

		// Parse attributes.
		$atts = shortcode_atts(
			array(
				'title' => __( 'Client Portal', 'kelbe-project-tracker' ),
			),
			$atts,
			'kpt_client_portal'
		);

		// Start output buffering.
		ob_start();

		// Load portal template.
		$this->load_portal_template( 'client', $atts );

		// Return the output.
		return ob_get_clean();
	}

	/**
	 * Render login message for non-logged in users
	 *
	 * @since  1.0.0
	 * @return string Login message HTML.
	 */
	private function render_login_message() {
		ob_start();
		?>
		<div class="kpt-login-required">
			<p><?php esc_html_e( 'You must be logged in to access this portal.', 'kelbe-project-tracker' ); ?></p>
			<p>
				<a href="<?php echo esc_url( wp_login_url( get_permalink() ) ); ?>" class="button">
					<?php esc_html_e( 'Log In', 'kelbe-project-tracker' ); ?>
				</a>
			</p>
		</div>
		<?php
		return ob_get_clean();
	}

	/**
	 * Load portal template
	 *
	 * @since 1.0.0
	 * @param string $portal_type Portal type (trade or client).
	 * @param array  $atts        Shortcode attributes.
	 */
	private function load_portal_template( $portal_type, $atts ) {
		// Get current user.
		$current_user = wp_get_current_user();

		// Determine template file.
		$template_file = $portal_type . '-portal.php';
		$template_path = plugin_dir_path( dirname( __FILE__ ) ) . 'templates/' . $template_file;

		// Check if template exists.
		if ( file_exists( $template_path ) ) {
			// Pass variables to template.
			$portal_title = $atts['title'];
			$user         = $current_user;

			// Include template.
			include $template_path;
		} else {
			// Template not found, show default message.
			$this->render_default_portal( $portal_type, $atts );
		}
	}

	/**
	 * Render default portal content when template is not found
	 *
	 * @since 1.0.0
	 * @param string $portal_type Portal type (trade or client).
	 * @param array  $atts        Shortcode attributes.
	 */
	private function render_default_portal( $portal_type, $atts ) {
		$current_user = wp_get_current_user();
		?>
		<div class="kpt-portal kpt-<?php echo esc_attr( $portal_type ); ?>-portal">
			<div class="kpt-portal-header">
				<h2><?php echo esc_html( $atts['title'] ); ?></h2>
				<p>
					<?php
					printf(
						/* translators: %s: User display name */
						esc_html__( 'Welcome, %s!', 'kelbe-project-tracker' ),
						esc_html( $current_user->display_name )
					);
					?>
				</p>
			</div>

			<div class="kpt-portal-content">
				<?php if ( 'trade' === $portal_type ) : ?>
					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'My Projects', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your assigned projects will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>

					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'Active Bids', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your bid submissions will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>

					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'Tasks', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your assigned tasks will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>
				<?php else : ?>
					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'My Projects', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your projects will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>

					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'Documents', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your project documents will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>

					<div class="kpt-portal-section">
						<h3><?php esc_html_e( 'Proposals', 'kelbe-project-tracker' ); ?></h3>
						<p><?php esc_html_e( 'Your proposals will appear here.', 'kelbe-project-tracker' ); ?></p>
					</div>
				<?php endif; ?>
			</div>

			<div class="kpt-portal-footer">
				<a href="<?php echo esc_url( wp_logout_url( home_url() ) ); ?>" class="button">
					<?php esc_html_e( 'Log Out', 'kelbe-project-tracker' ); ?>
				</a>
			</div>
		</div>
		<?php
	}

	/**
	 * Prevent cloning of the instance
	 *
	 * @since 1.0.0
	 */
	private function __clone() {}

	/**
	 * Prevent unserializing of the instance
	 *
	 * @since 1.0.0
	 */
	private function __wakeup() {}
}
